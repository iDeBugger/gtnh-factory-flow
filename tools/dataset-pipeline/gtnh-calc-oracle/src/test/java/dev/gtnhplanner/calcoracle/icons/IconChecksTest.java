package dev.gtnhplanner.calcoracle.icons;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.image.BufferedImage;
import java.io.InputStream;

import javax.imageio.ImageIO;

import org.junit.jupiter.api.Test;

class IconChecksTest {

    /** The computronics colorful upgrade (2.8.1 ocParts@7) as drawn while its cycling tint sat on magenta. */
    @Test
    void keepsAnItemTintedMagenta() throws Exception {
        InputStream in = IconChecksTest.class.getResourceAsStream("/icons/colorful-upgrade-magenta.png");
        BufferedImage image = ImageIO.read(in);
        int[] argb = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());

        assertEquals(0.0D, IconChecks.missingTextureRatio(argb));
        assertTrue(IconChecks.usable(argb));
    }

    /** 1.7.10's missing texture: a 16x16 item of 8x8 magenta and black squares, centred in the 32x32 canvas. */
    @Test
    void dropsTheMissingTextureCheckerboard() {
        int[] argb = new int[32 * 32];
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                boolean magenta = (x < 8) == (y < 8);
                argb[(y + 8) * 32 + x + 8] = magenta ? 0xFFF800F8 : 0xFF000000;
            }
        }

        assertEquals(0.5D, IconChecks.missingTextureRatio(argb));
        assertFalse(IconChecks.usable(argb));
    }

    @Test
    void keepsAPlainMagentaSquare() {
        int[] argb = new int[16 * 16];
        for (int i = 0; i < argb.length; i++) {
            argb[i] = 0xFFF800F8;
        }

        assertTrue(IconChecks.usable(argb));
    }
}
