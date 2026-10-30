package in.equidron.agents;

import static in.equidron.agents.PolicyGate.Decision.*;
import static in.equidron.agents.PolicyGate.Risk.*;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * The gate is pure logic, so it is tested exhaustively rather than sampled: the table is the product.
 */
class PolicyGateTest {

    private static PolicyGate.Decision d(PolicyGate.Risk risk, int level, long amount, long limit) {
        return PolicyGate.decide(risk, level, amount, limit, 1.00, false);
    }

    @Test
    void aReadIsAlwaysAllowedButNotWhenPausedOrOutOfBudget() {
        assertEquals(EXECUTE, d(READ, 1, 0, 0));
        assertEquals(EXECUTE, d(READ, 5, 0, 0));
        assertEquals(DENY, PolicyGate.decide(READ, 5, 0, 0, 0, false), "no budget left");
        assertEquals(DENY, PolicyGate.decide(READ, 5, 0, 0, 1.0, true), "pause-all");
    }

    @Test
    void aWriteIsShadowedBelowLevelThreeAndExecutedAtThreeAndAbove() {
        assertEquals(SHADOW, d(WRITE, 1, 0, 0));
        assertEquals(SHADOW, d(WRITE, 2, 0, 0));
        assertEquals(EXECUTE, d(WRITE, 3, 0, 0));
        assertEquals(EXECUTE, d(WRITE, 5, 0, 0));
    }

    @Test
    void moneyWaitsForAPersonBelowLevelThree() {
        assertEquals(NEEDS_APPROVAL, d(MONEY, 1, 100, 1000));
        assertEquals(NEEDS_APPROVAL, d(MONEY, 2, 100, 1000));
    }

    @Test
    void moneyInsideTheAgentsOwnLimitIsAutomaticAndAboveItIsNot() {
        assertEquals(EXECUTE, d(MONEY, 4, 500, 1000));
        assertEquals(EXECUTE, d(MONEY, 4, 1000, 1000), "the limit is inclusive");
        assertEquals(NEEDS_APPROVAL, d(MONEY, 4, 1001, 1000));
        assertEquals(NEEDS_APPROVAL, d(MONEY, 5, 1, 0), "no limit set means no automatic money");
    }

    @Test
    void irreversibleActionsAlwaysNeedAPersonEvenAtTheHighestLevel() {
        assertEquals(NEEDS_APPROVAL, d(IRREVERSIBLE, 1, 0, 0));
        assertEquals(NEEDS_APPROVAL, d(IRREVERSIBLE, 5, 0, 100000));
    }

    @Test
    void anImpossibleLevelIsRefusedRatherThanTreatedAsHigh() {
        assertEquals(DENY, d(WRITE, 0, 0, 0));
        assertEquals(DENY, d(WRITE, 9, 0, 0));
    }
}
