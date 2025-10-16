
#include <chrono>
#include <cmath>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

struct Player {
    std::string id;
    std::string name;
    double xp = 0.0;     // current XP toward next rank
    int rank = 0;        // current rank/level
    int killStreak = 0;  // consecutive kills without dying
    TimePoint lastTick = Clock::now();

    Player() = default;
    Player(const std::string& pid, const std::string& pname)
        : id(pid), name(pname), xp(0.0), rank(0), killStreak(0), lastTick(Clock::now()) {}
};

class RankingSystem {
public:
    RankingSystem()
    {}

    // Add a new player if not exists.
    void AddPlayer(const std::string& id, const std::string& name) {
        std::lock_guard<std::mutex> lg(m_);
        if (players_.count(id)) return;
        players_.emplace(id, Player(id, name));
    }

    // Record a kill event: killerId killed victimId.
    // This increases killer XP and kill streak, resets victim's streak, and may change ranks.
    void RecordKill(const std::string& killerId, const std::string& victimId) {
        std::lock_guard<std::mutex> lg(m_);
        if (!players_.count(killerId) || !players_.count(victimId)) return;

        Player& killer = players_.at(killerId);
        Player& victim = players_.at(victimId);

        // Award XP: base + victimRankScale, with streak multiplier.
        double baseXp = 100.0;
        double victimScale = 10.0 * victim.rank; // more XP for killing higher rank
        killer.killStreak += 1;
        double streakMultiplier = 1.0 + 0.1 * std::clamp(killer.killStreak - 1, 0, 100);
        double gainedXp = (baseXp + victimScale) * streakMultiplier;

        killer.xp += gainedXp;
        // Reset victim's streak
        victim.killStreak = 0;

        // Immediately try to level up killer (multiple ranks possible)
        applyRankUps(killer);
    }

    // Call periodically (e.g., each server tick) to apply passive XP gains over time
    // deltaSeconds is seconds since last call for each player; if zero, it computes using lastTick.
    void TickAll() {
        std::lock_guard<std::mutex> lg(m_);
        auto now = Clock::now();
        for (auto& kv : players_) {
            Player& p = kv.second;
            double delta = std::chrono::duration_cast<std::chrono::duration<double>>(now - p.lastTick).count();
            if (delta <= 0.0) continue;
            // Passive XP: small amount scaled by sqrt(rank+1)
            double passivePerSecond = 1.0 * std::sqrt(double(p.rank + 1));
            p.xp += passivePerSecond * delta;

            // Slight decay on kill streak over time (optional): reduce by 0.1 per 30s
            double streakDecay = delta / 30.0 * 0.1;
            if (streakDecay > 0.0 && p.killStreak > 0) {
                int decaySteps = int(streakDecay);
                if (decaySteps > 0) p.killStreak = std::max(0, p.killStreak - decaySteps);
            }

            p.lastTick = now;

            applyRankUps(p);
        }
    }

    // Get a snapshot of a player's info
    bool GetPlayerInfo(const std::string& id, std::string& outName, int& outRank, double& outXp, int& outStreak) {
        std::lock_guard<std::mutex> lg(m_);
        if (!players_.count(id)) return false;
        const Player& p = players_.at(id);
        outName = p.name;
        outRank = p.rank;
        outXp = p.xp;
        outStreak = p.killStreak;
        return true;
    }

    // For debugging: print all players
    void PrintAll() {
        std::lock_guard<std::mutex> lg(m_);
        std::cout << "---- Players ----\n";
        for (const auto& kv : players_) {
            const Player& p = kv.second;
            std::cout << p.id << " | " << p.name << " | Rank: " << p.rank << " | XP: " << int(p.xp)
                      << " | Streak: " << p.killStreak << "\n";
        }
        std::cout << "-----------------\n";
    }

private:
    std::unordered_map<std::string, Player> players_;
    std::mutex m_;

    // XP required for next rank. Increases exponentially.
    static double xpThresholdForRank(int rank) {
        double base = 300.0;
        return base * std::pow(1.5, rank);
    }

    // Apply rank-ups while xp >= threshold.
    void applyRankUps(Player& p) {
        while (p.xp >= xpThresholdForRank(p.rank)) {
            double thresh = xpThresholdForRank(p.rank);
            p.xp -= thresh;
            p.rank += 1;
            // Optional: on-rank-up event (could log, notify, reward, etc.)
            std::cout << "[RankUp] " << p.name << " reached rank " << p.rank << "\n";
        }
        // Cap XP to avoid runaway numbers when rank very high
        double cap = xpThresholdForRank(p.rank) * 2.0;
        if (p.xp > cap) p.xp = cap;
    }
};

// Example usage: integrate these calls into your server's event loop / JS bridge.
int main() {
    RankingSystem rs;
    rs.AddPlayer("p1", "Alice");
    rs.AddPlayer("p2", "Bob");
    rs.AddPlayer("p3", "Carol");

    // Simulate gameplay
    rs.RecordKill("p1", "p2"); // Alice kills Bob
    rs.TickAll();
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    rs.RecordKill("p1", "p3"); // Alice kills Carol -> streak
    rs.TickAll();

    // Simulate time passing so passive xp accumulates
    std::this_thread::sleep_for(std::chrono::seconds(2));
    rs.TickAll();

    // More kills
    rs.RecordKill("p2", "p1"); // Bob kills Alice
    rs.TickAll();

    rs.PrintAll();

    // In a real server you would:
    // - Call TickAll() on a fixed interval (e.g., every 1s).
    // - Call RecordKill(...) whenever a kill happens (from your JS server or engine).
    // - Expose GetPlayerInfo(...) to your JS layer (via native addon, IPC, or network).

    return 0;
}