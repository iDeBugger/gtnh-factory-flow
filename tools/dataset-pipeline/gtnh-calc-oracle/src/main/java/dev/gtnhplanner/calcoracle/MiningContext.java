package dev.gtnhplanner.calcoracle;

import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.FluidStack;

import java.util.Map;

/**
 * The exporter helpers a per-pack MiningExport needs, so item, fluid and adapter rows
 * come out exactly as the rest of the export writes them.
 */
public interface MiningContext {
    Map<String, Object> domain(String id);

    Map<String, Object> map();

    void putIfPresent(Map<String, Object> target, String key, Object value);

    String safeString(Object value);

    Map<String, Object> adapter(
        String id,
        String status,
        boolean detected,
        int subjectCount,
        int recipeCount,
        long started,
        String warning
    );

    Map<String, Object> itemStack(ItemStack stack);

    Map<String, Object> fluidStack(FluidStack stack);
}
