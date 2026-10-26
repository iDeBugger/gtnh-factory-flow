package dev.gtnhplanner.calcoracle.icons;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Collection;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Holds GregTech's material colours at the values the materials define while icons render.
 *
 * <p>GregTech 5.09.51 (GTNH 2.8.1) animates some materials' colours on every client tick: its client proxy walks
 * lists such as {@code mPosR} and {@code mMoltenNegB} (Enderium, Thaumium, the infused materials, Uranium,
 * Plutonium, Naquadria, Nether Star, Force, Vinteum, Sunnarium...) and moves one channel of each {@code mRGBa} or
 * {@code mMoltenRGBa} by one, turning round every 50 ticks. An icon showed whatever colour the tick count had
 * reached when it was drawn, so two exports of one pack drew about 2,000 icons a few to 30 levels apart.
 *
 * <p>The colours are copied when loading completes, before the first client tick, which is the colour each material
 * is defined with. While icons render, the proxy's animation lists are emptied and the copied colours put back;
 * {@link #thaw()} gives the lists back. 2.9's GregTech animates no colours this way, and finds no list to empty.
 */
public final class MaterialColorFreezer {

    private static final Pattern ANIMATION_LIST = Pattern.compile("^m(Molten)?(Pos|Neg)[RGBA]$");
    private static Map<short[], short[]> definedColours;
    private static final Map<Field, Object> heldLists = new LinkedHashMap<Field, Object>();
    private static Object heldProxy;

    private MaterialColorFreezer() {}

    /** Copies every material's colours as loading left them. Call once loading completes, before any client tick. */
    public static void snapshot() {
        if (definedColours != null) {
            return;
        }
        Map<short[], short[]> colours = new IdentityHashMap<short[], short[]>();
        try {
            Class<?> materials = Class.forName("gregtech.api.enums.Materials");
            Collection<?> all = (Collection<?>) materials.getMethod("getAll").invoke(null);
            Field rgba = materials.getField("mRGBa");
            Field molten = materials.getField("mMoltenRGBa");
            for (Object material : all) {
                for (Field field : new Field[] {rgba, molten}) {
                    short[] colour = (short[]) field.get(material);
                    if (colour != null) {
                        colours.put(colour, colour.clone());
                    }
                }
            }
        } catch (Throwable t) {
            GtnhCalcOracleMod.LOG.info("GTNH icon export found no GregTech material colours to hold: " + t);
        }
        definedColours = colours;
    }

    /** Stops the colour animation and puts every material back on its defined colour. */
    static void freeze() {
        if (definedColours == null || heldProxy != null) {
            return;
        }
        Object proxy = gregtechProxy();
        if (proxy == null) {
            return;
        }
        int lists = 0;
        for (Class<?> type = proxy.getClass(); type != null && type != Object.class; type = type.getSuperclass()) {
            for (Field field : type.getDeclaredFields()) {
                if (Modifier.isStatic(field.getModifiers()) || !List.class.isAssignableFrom(field.getType())
                    || !ANIMATION_LIST.matcher(field.getName()).matches()) {
                    continue;
                }
                try {
                    field.setAccessible(true);
                    heldLists.put(field, field.get(proxy));
                    field.set(proxy, Collections.emptyList());
                    lists++;
                } catch (Throwable t) {
                    GtnhCalcOracleMod.LOG.warn("Could not hold GregTech's colour animation " + field.getName() + ": " + t);
                }
            }
        }
        heldProxy = proxy;
        if (lists == 0) {
            return;
        }
        for (Map.Entry<short[], short[]> entry : definedColours.entrySet()) {
            System.arraycopy(entry.getValue(), 0, entry.getKey(), 0, entry.getValue().length);
        }
        GtnhCalcOracleMod.LOG.info(
            "GTNH icon export holds GregTech's " + lists + " colour animation list(s) and " + definedColours.size()
                + " material colour(s) at their defined values."
        );
    }

    /** Gives the proxy its animation lists back; the colours run on from their defined values. */
    static void thaw() {
        if (heldProxy == null) {
            return;
        }
        for (Map.Entry<Field, Object> entry : heldLists.entrySet()) {
            try {
                entry.getKey().set(heldProxy, entry.getValue());
            } catch (Throwable ignored) {
            }
        }
        heldLists.clear();
        heldProxy = null;
    }

    private static Object gregtechProxy() {
        for (String className : new String[] {"gregtech.GT_Mod", "gregtech.GTMod"}) {
            try {
                return Class.forName(className).getField("gregtechproxy").get(null);
            } catch (Throwable ignored) {
            }
        }
        return null;
    }
}
