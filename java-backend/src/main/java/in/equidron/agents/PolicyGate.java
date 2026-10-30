package in.equidron.agents;

/**
 * The policy gate: the one place that decides whether an agent may do something.
 *
 * It is a pure function on purpose. No database, no model, no clock, no randomness - so every rule is
 * testable, and a prompt cannot talk its way past it. The agent's level, the tool's risk and the
 * amount decide the outcome; nothing else does.
 *
 * The four outcomes, in order of how much freedom they give:
 *   EXECUTE        - do it now
 *   SHADOW         - would have done it; record what it would have done, change nothing
 *   NEEDS_APPROVAL - a person must say yes; the action waits in the inbox
 *   DENY           - never, at this level
 *
 * Rules that mirror the Node implementation:
 *   - a read is always allowed, at any level, because it changes nothing;
 *   - money and irreversible actions are never automatic at L1-L3, and at L4 still need approval
 *     above the agent's limit;
 *   - a level below the tool's minimum is a refusal, not a downgrade - guessing intent is worse than
 *     saying no;
 *   - with no budget left, even a read that costs money is refused.
 */
public final class PolicyGate {

    public enum Risk { READ, WRITE, MONEY, IRREVERSIBLE }
    public enum Decision { EXECUTE, SHADOW, NEEDS_APPROVAL, DENY }

    /** The minimum autonomy level at which each risk may be taken without a person. */
    private static final int MIN_LEVEL_FOR_WRITE = 3;

    private PolicyGate() {}

    /**
     * @param risk          what the tool does
     * @param level         the agent's autonomy level, 1 to 5
     * @param amountPaise   money involved, or 0
     * @param autoLimitPaise the agent's own limit for automatic spending, or 0 if it has none
     * @param budgetLeftUsd what remains of today's budget; a negative value means exhausted
     * @param paused        the pause-all switch
     */
    public static Decision decide(Risk risk, int level, long amountPaise, long autoLimitPaise,
                                  double budgetLeftUsd, boolean paused) {
        if (paused) return Decision.DENY;
        if (budgetLeftUsd <= 0) return Decision.DENY;
        if (risk == Risk.READ) return Decision.EXECUTE;

        if (level < 1 || level > 5) return Decision.DENY;

        switch (risk) {
            case WRITE:
                // Writes are the ordinary work of an agent at L3 and above; below that, a person is
                // meant to be the one acting, so the agent only shows what it would have done.
                if (level >= MIN_LEVEL_FOR_WRITE) return Decision.EXECUTE;
                return Decision.SHADOW;
            case MONEY:
                if (level < 3) return Decision.NEEDS_APPROVAL;
                // Even at L4/L5, money above the agent's own limit needs a person. Zero means the
                // agent has no automatic limit at all.
                if (autoLimitPaise > 0 && amountPaise <= autoLimitPaise) return Decision.EXECUTE;
                return Decision.NEEDS_APPROVAL;
            case IRREVERSIBLE:
                // Deleting, cancelling, changing a permission: always a person, at every level.
                return Decision.NEEDS_APPROVAL;
            default:
                return Decision.DENY;
        }
    }
}
