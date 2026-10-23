package dev.gtnhplanner.calcoracle.icons;

/**
 * Whether an item icon is worth keeping, on its pixels as ARGB ints: a rendered icon is dropped and a cached one
 * rendered again when this says no. The icon pack's format includes this check's answers on fixed images
 * (IconCache.fingerprint), so a pack hit, which skips the check, never outlives a change here.
 */
final class IconChecks {

    /** At or above this share of magenta (missing texture) pixels an icon is dropped. */
    static final double MISSING_TEXTURE_LIMIT = 0.5D;

    private IconChecks() {}

    static boolean usable(int[] argb) {
        return hasVisiblePixels(argb) && missingTextureRatio(argb) < MISSING_TEXTURE_LIMIT;
    }

    static boolean hasVisiblePixels(int[] argb) {
        for (int value : argb) {
            if (((value >>> 24) & 255) > 0) {
                return true;
            }
        }
        return false;
    }

    static double missingTextureRatio(int[] argb) {
        int visiblePixels = 0;
        int missingTexturePixels = 0;
        for (int value : argb) {
            int alpha = (value >>> 24) & 255;
            if (alpha == 0) {
                continue;
            }

            visiblePixels++;
            int red = (value >> 16) & 255;
            int green = (value >> 8) & 255;
            int blue = value & 255;
            if (red >= 220 && green <= 40 && blue >= 220) {
                missingTexturePixels++;
            }
        }

        return visiblePixels > 0 ? (double) missingTexturePixels / (double) visiblePixels : 0.0D;
    }
}
