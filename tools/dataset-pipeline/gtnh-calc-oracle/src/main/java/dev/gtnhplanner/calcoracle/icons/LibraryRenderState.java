package dev.gtnhplanner.calcoracle.icons;

import java.lang.reflect.Method;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * The CodeChickenLib render state each icon starts from: CCL's defaults (reset), then the dynamic lighting its item
 * renderers switch on (setDynamic: normals on, CCL's own face shading off, GL lighting does the shading).
 *
 * CCL keeps its state from one model render to the next, and a renderer that sets none inherits the last one's.
 * Without a reset, 2.8.1's Logistics Pipes crafting table, power junction and security station drew nothing after
 * the icons before them. A reset alone leaves CCL's face shading on, which no CCL item renderer leaves behind: 2.9's
 * Logistics Pipes pipe items bake whatever state their first draw finds into a vertex buffer, and came out a shade
 * darker than the game draws them. In the game the inherited state is the dynamic one: two thirds of the icons an
 * export draws without a reset inherit it, every Logistics Pipes item among them, and a chest GUI frame draws the
 * pipes flat.
 */
final class LibraryRenderState {

    static final String CCL_RENDER_STATE = "codechicken.lib.render.CCRenderState";

    private final Method reset;
    private final Method setDynamic;
    private boolean failureWarned;

    /** Finds the class's static reset() and setDynamic(); both null when the library is not loaded. */
    LibraryRenderState(String className) {
        Method foundReset = null;
        Method foundDynamic = null;
        try {
            Class<?> state = Class.forName(className);
            foundReset = state.getMethod("reset");
            foundDynamic = state.getMethod("setDynamic");
        } catch (ClassNotFoundException absent) {
            // No CodeChickenLib in this pack: nothing to reset.
        } catch (Throwable t) {
            // The library is there but without the methods: say so, or the reset is a silent no-op.
            GtnhCalcOracleMod.LOG.warn("GTNH icon exporter found " + className + " without reset() and setDynamic(): " + t);
            foundReset = null;
            foundDynamic = null;
        }
        this.reset = foundReset;
        this.setDynamic = foundDynamic;
    }

    boolean present() {
        return reset != null;
    }

    /** Puts the library's state where an icon starts; a failure is logged once and never stops the render. */
    void apply() {
        if (reset == null) {
            return;
        }
        try {
            reset.invoke(null);
            setDynamic.invoke(null);
        } catch (Throwable t) {
            if (!failureWarned) {
                failureWarned = true;
                GtnhCalcOracleMod.LOG.warn("GTNH icon exporter could not reset CodeChickenLib's render state: " + t);
            }
        }
    }
}
