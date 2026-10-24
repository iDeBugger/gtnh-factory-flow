package dev.gtnhplanner.calcoracle.icons;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LibraryRenderStateTest {

    /** CodeChickenLib's CCRenderState as far as an icon's start sees it: reset() and setDynamic() and their fields. */
    public static final class FakeRenderState {
        static boolean computeLighting;
        static boolean useNormals;
        static int alphaOverride;
        static StringBuilder calls = new StringBuilder();

        public static void reset() {
            computeLighting = true;
            useNormals = false;
            alphaOverride = -1;
            calls.append("reset;");
        }

        public static void setDynamic() {
            useNormals = true;
            computeLighting = false;
            calls.append("setDynamic;");
        }
    }

    @BeforeEach
    void leftoverState() {
        // What a model drawn before the icon could leave: an alpha override of 0 draws nothing.
        FakeRenderState.computeLighting = true;
        FakeRenderState.useNormals = false;
        FakeRenderState.alphaOverride = 0;
        FakeRenderState.calls = new StringBuilder();
    }

    @Test
    void startsEachIconFromTheResetDynamicState() {
        LibraryRenderState state = new LibraryRenderState(FakeRenderState.class.getName());

        assertTrue(state.present());
        state.apply();

        assertEquals("reset;setDynamic;", FakeRenderState.calls.toString());
        assertEquals(-1, FakeRenderState.alphaOverride);
        assertFalse(FakeRenderState.computeLighting);
        assertTrue(FakeRenderState.useNormals);
    }

    @Test
    void doesNothingWithoutTheLibrary() {
        LibraryRenderState state = new LibraryRenderState("codechicken.lib.render.NoSuchRenderState");

        assertFalse(state.present());
        state.apply();

        assertEquals("", FakeRenderState.calls.toString());
    }
}
