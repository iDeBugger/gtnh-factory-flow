package dev.gtnhplanner.calcoracle.icons;

/**
 * Whether an item icon is worth keeping, on its pixels as ARGB ints: a rendered icon is dropped and a cached one
 * rendered again when this says no. The icon pack's format includes this check's answers on fixed images
 * (IconCache.fingerprint), so a pack hit, which skips the check, never outlives a change here.
 */
final class IconChecks {

    /** At or above this share of magenta (missing texture) pixels an icon is dropped. */
    static final double MISSING_TEXTURE_LIMIT = 0.5D;
    /** The missing texture is half magenta, half black; a rendered one keeps about as much black as magenta. */
    static final double MISSING_TEXTURE_BLACK_SHARE = 0.8D;

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

    /**
     * The share of visible pixels that are the missing texture's magenta, counted only when the icon also holds the
     * checkerboard's black half (at least MISSING_TEXTURE_BLACK_SHARE as many near-black pixels as magenta ones).
     * Magenta alone is an item tinted magenta, such as a colour-cycling upgrade drawn while its hue sat there.
     */
    static double missingTextureRatio(int[] argb) {
        int visiblePixels = 0;
        int missingTexturePixels = 0;
        int blackPixels = 0;
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
            } else if (red <= 40 && green <= 40 && blue <= 40) {
                blackPixels++;
            }
        }

        if (visiblePixels == 0 || blackPixels < MISSING_TEXTURE_BLACK_SHARE * missingTexturePixels) {
            return 0.0D;
        }
        return (double) missingTexturePixels / (double) visiblePixels;
    }
}
