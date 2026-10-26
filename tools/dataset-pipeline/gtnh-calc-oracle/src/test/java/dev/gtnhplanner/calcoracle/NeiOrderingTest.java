package dev.gtnhplanner.calcoracle;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

class NeiOrderingTest {

    /** Stacks as "group/name": group "-" is none. */
    private static int group(String stack) {
        String group = stack.substring(0, stack.indexOf('/'));
        return "-".equals(group) ? -1 : Integer.parseInt(group);
    }

    @Test
    void putsAGroupsMembersTogetherAtItsFirstMembersPlace() throws Exception {
        // Sorted by mod and id: IC2's cell, then GT's stone, then GT's cells, then a lone item.
        List<String> sorted = Arrays.asList("7/ic2 cell", "-/gt stone", "7/gt cell a", "3/gt dust", "7/gt cell b", "-/zz");
        List<String> shown = NeiOrdering.groupOrdered(sorted, NeiOrderingTest::group);
        assertEquals(Arrays.asList("7/ic2 cell", "7/gt cell a", "7/gt cell b", "-/gt stone", "3/gt dust", "-/zz"), shown);
    }

    @Test
    void leavesAListWithNoGroupsAsSorted() throws Exception {
        List<String> sorted = Arrays.asList("-/b", "-/a", "-/c");
        assertEquals(sorted, NeiOrdering.groupOrdered(sorted, NeiOrderingTest::group));
    }
}
