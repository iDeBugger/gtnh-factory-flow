package dev.gtnhplanner.calcoracle;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

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

    @Test
    void waitsForTheNamedThreadToEnd() throws Exception {
        AtomicBoolean done = new AtomicBoolean(false);
        Thread loader = new Thread(() -> {
            try {
                Thread.sleep(300L);
            } catch (InterruptedException ignored) {
            }
            done.set(true);
        }, "NEI Plugin Loader");
        loader.start();
        NeiOrdering.joinThreadsNamed("NEI Plugin Loader", System.currentTimeMillis() + 10_000L);
        assertFalse(loader.isAlive());
        assertEquals(true, done.get());
    }

    @Test
    void givesUpAtTheDeadline() throws Exception {
        Thread loader = new Thread(() -> {
            try {
                Thread.sleep(5_000L);
            } catch (InterruptedException ignored) {
            }
        }, "NEI Plugin Loader");
        loader.setDaemon(true);
        loader.start();
        assertThrows(IllegalStateException.class,
            () -> NeiOrdering.joinThreadsNamed("NEI Plugin Loader", System.currentTimeMillis() + 100L));
        loader.interrupt();
    }
}
