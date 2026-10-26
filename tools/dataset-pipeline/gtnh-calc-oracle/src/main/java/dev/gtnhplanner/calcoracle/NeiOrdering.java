package dev.gtnhplanner.calcoracle;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The plain parts of NEI's list order, kept apart from the reflection so they can be tested
 * outside the game (NeiOrderingTest).
 */
final class NeiOrdering {

    private NeiOrdering() {}

    /** What a stack's collapsible group is: NEI's CollapsibleItems.getGroupIndex, -1 for none. */
    interface GroupOf<T> {
        int groupIndex(T stack) throws Exception;
    }

    /**
     * The order NEI's panel shows after ItemSorter.sort: both NEI versions number the sorted list
     * (updateOrdering), giving every member of a collapsible group the number of the group's first
     * member, and the panel stable-sorts by that number (updateFilter). So a group's members stand
     * together at the first member's place, in their sorted order, expanded or not.
     */
    static <T> List<T> groupOrdered(List<T> sorted, GroupOf<T> groupOf) throws Exception {
        final int[] number = new int[sorted.size()];
        Map<Integer, Integer> groupNumbers = new HashMap<Integer, Integer>();
        int next = 0;
        for (int at = 0; at < sorted.size(); at++) {
            int group = groupOf.groupIndex(sorted.get(at));
            if (group == -1) {
                number[at] = next++;
            } else {
                Integer known = groupNumbers.get(Integer.valueOf(group));
                if (known == null) {
                    known = Integer.valueOf(next++);
                    groupNumbers.put(Integer.valueOf(group), known);
                }
                number[at] = known.intValue();
            }
        }
        List<Integer> positions = new ArrayList<Integer>(sorted.size());
        for (int at = 0; at < sorted.size(); at++) {
            positions.add(Integer.valueOf(at));
        }
        // Collections.sort is stable, as NEI's List.sort is.
        Collections.sort(positions, new Comparator<Integer>() {
            @Override
            public int compare(Integer left, Integer right) {
                return Integer.compare(number[left.intValue()], number[right.intValue()]);
            }
        });
        List<T> ordered = new ArrayList<T>(sorted.size());
        for (Integer position : positions) {
            ordered.add(sorted.get(position.intValue()));
        }
        return ordered;
    }
}
