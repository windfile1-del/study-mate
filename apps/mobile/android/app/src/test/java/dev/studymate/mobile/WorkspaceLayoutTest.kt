package dev.studymate.mobile

import org.junit.Assert.*
import org.junit.Test

class WorkspaceLayoutTest {
    @Test
    fun clampsSidebarAndCompanionWidthsWithinSafeBounds() {
        // On a 1200dp tablet, nav + companion must leave at least 300dp for main area
        assertEquals(180f, WorkspaceLayoutMath.clampNavWidth(80f, 1200f, 340f), 0.01f)
        assertEquals(440f, WorkspaceLayoutMath.clampNavWidth(900f, 1200f, 340f), 0.01f)
        assertEquals(250f, WorkspaceLayoutMath.clampCompanionWidth(100f, 1200f, 248f), 0.01f)
        assertEquals(652f, WorkspaceLayoutMath.clampCompanionWidth(900f, 1200f, 248f), 0.01f)
    }

    @Test
    fun clampsNarrowContainerWithoutNegativeMainWidth() {
        val nav = WorkspaceLayoutMath.clampNavWidth(320f, 700f, 250f)
        assertTrue(nav <= 180f)
    }

    @Test
    fun clampsFloatingWindowInsideViewport() {
        val clamped = WorkspaceLayoutMath.clampFloatingBounds(
            FloatingBounds(xDp = 950f, yDp = 700f, widthDp = 500f, heightDp = 600f),
            containerWidthDp = 1000f,
            containerHeightDp = 720f,
        )
        assertTrue(clamped.xDp + clamped.widthDp <= 1000f - 8f + 0.1f)
        assertTrue(clamped.yDp + clamped.heightDp <= 720f - 8f + 0.1f)
        assertTrue(clamped.xDp >= 8f)
        assertTrue(clamped.yDp >= 8f)
    }

    @Test
    fun clampsSplitFractions() {
        assertEquals(0.22f, WorkspaceLayoutMath.clampFraction(0.05f), 0.001f)
        assertEquals(0.76f, WorkspaceLayoutMath.clampFraction(0.95f), 0.001f)
        assertEquals(0.50f, WorkspaceLayoutMath.clampFraction(0.50f), 0.001f)
    }

    @Test
    fun chromeCollapsedDefaultsToFalse() {
        val state = WorkspaceLayoutState()
        assertFalse(state.chromeCollapsed)
    }
}
