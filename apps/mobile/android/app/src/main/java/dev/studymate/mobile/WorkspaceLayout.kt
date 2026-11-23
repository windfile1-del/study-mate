package dev.studymate.mobile

import android.content.Context
import org.json.JSONObject

enum class PanelMode {
    DOCKED,
    HIDDEN,
    FLOATING,
}

data class FloatingBounds(
    val xDp: Float,
    val yDp: Float,
    val widthDp: Float,
    val heightDp: Float,
    val minimized: Boolean = false,
)

data class WorkspaceLayoutState(
    val navMode: PanelMode = PanelMode.DOCKED,
    val assistantMode: PanelMode = PanelMode.DOCKED,
    val compactSplit: Boolean = false,
    val compactBottomKind: String = "chat",
    val chromeCollapsed: Boolean = false,
    val navWidthDp: Float = 248f,
    val companionWidthDp: Float = 340f,
    val dockHeightFraction: Float = 0.44f,
    val compactSplitFraction: Float = 0.52f,
    val navFloating: FloatingBounds = FloatingBounds(16f, 56f, 296f, 440f, false),
    val assistantFloating: FloatingBounds = FloatingBounds(56f, 64f, 360f, 480f, false),
    val frontWindow: String = "assistant",
    val fontSize: Int = 16,
    val lineHeight: Float = 1.82f,
    val readerTheme: String = "paper",
)

object WorkspaceLayoutMath {
    const val DEFAULT_NAV_WIDTH = 248f
    const val DEFAULT_COMPANION_WIDTH = 340f
    const val DEFAULT_DOCK_FRACTION = 0.44f
    const val DEFAULT_COMPACT_SPLIT_FRACTION = 0.52f
    const val MIN_MAIN_WIDTH = 300f

    fun clampNavWidth(widthDp: Float, containerWidthDp: Float, companionOccupiedDp: Float): Float {
        val maxAllowed = (containerWidthDp - companionOccupiedDp - MIN_MAIN_WIDTH).coerceIn(180f, 440f)
        return widthDp.coerceIn(180f, maxAllowed)
    }

    fun clampCompanionWidth(widthDp: Float, containerWidthDp: Float, navOccupiedDp: Float): Float {
        val maxAllowed = (containerWidthDp - navOccupiedDp - MIN_MAIN_WIDTH).coerceIn(250f, 660f)
        return widthDp.coerceIn(250f, maxAllowed)
    }

    fun clampFraction(fraction: Float, min: Float = 0.22f, max: Float = 0.76f): Float =
        fraction.coerceIn(min, max)

    fun clampFloatingBounds(
        bounds: FloatingBounds,
        containerWidthDp: Float,
        containerHeightDp: Float,
        minWidthDp: Float = 240f,
        minHeightDp: Float = 220f,
    ): FloatingBounds {
        val maxW = (containerWidthDp - 16f).coerceAtLeast(minWidthDp)
        val maxH = (containerHeightDp - 16f).coerceAtLeast(minHeightDp)
        val width = bounds.widthDp.coerceIn(minWidthDp, maxW)
        val height = bounds.heightDp.coerceIn(minHeightDp, maxH)
        val maxX = (containerWidthDp - width - 8f).coerceAtLeast(8f)
        val maxY = (containerHeightDp - height - 8f).coerceAtLeast(8f)
        return bounds.copy(
            xDp = bounds.xDp.coerceIn(8f, maxX),
            yDp = bounds.yDp.coerceIn(8f, maxY),
            widthDp = width,
            heightDp = height,
        )
    }

    fun encode(state: WorkspaceLayoutState): String = JSONObject()
        .put("navMode", state.navMode.name)
        .put("assistantMode", state.assistantMode.name)
        .put("compactSplit", state.compactSplit)
        .put("compactBottomKind", state.compactBottomKind)
        .put("chromeCollapsed", state.chromeCollapsed)
        .put("navWidthDp", state.navWidthDp.toDouble())
        .put("companionWidthDp", state.companionWidthDp.toDouble())
        .put("dockHeightFraction", state.dockHeightFraction.toDouble())
        .put("compactSplitFraction", state.compactSplitFraction.toDouble())
        .put("navFloating", encodeBounds(state.navFloating))
        .put("assistantFloating", encodeBounds(state.assistantFloating))
        .put("frontWindow", state.frontWindow)
        .put("fontSize", state.fontSize)
        .put("lineHeight", state.lineHeight.toDouble())
        .put("readerTheme", state.readerTheme)
        .toString()

    fun decode(raw: String?): WorkspaceLayoutState {
        if (raw.isNullOrBlank()) return WorkspaceLayoutState()
        return runCatching {
            val json = JSONObject(raw)
            val navMode = runCatching { PanelMode.valueOf(json.optString("navMode", "DOCKED")) }.getOrDefault(PanelMode.DOCKED)
            val assistantMode = runCatching { PanelMode.valueOf(json.optString("assistantMode", "DOCKED")) }.getOrDefault(PanelMode.DOCKED)
            val theme = json.optString("readerTheme", "paper").let { if (it in listOf("paper", "warm", "mint")) it else "paper" }
            WorkspaceLayoutState(
                navMode = navMode,
                assistantMode = assistantMode,
                compactSplit = json.optBoolean("compactSplit", false),
                compactBottomKind = json.optString("compactBottomKind", "chat"),
                chromeCollapsed = json.optBoolean("chromeCollapsed", false),
                navWidthDp = json.optDouble("navWidthDp", DEFAULT_NAV_WIDTH.toDouble()).toFloat().coerceIn(180f, 440f),
                companionWidthDp = json.optDouble("companionWidthDp", DEFAULT_COMPANION_WIDTH.toDouble()).toFloat().coerceIn(250f, 660f),
                dockHeightFraction = clampFraction(json.optDouble("dockHeightFraction", DEFAULT_DOCK_FRACTION.toDouble()).toFloat()),
                compactSplitFraction = clampFraction(json.optDouble("compactSplitFraction", DEFAULT_COMPACT_SPLIT_FRACTION.toDouble()).toFloat()),
                navFloating = decodeBounds(json.optJSONObject("navFloating"), FloatingBounds(16f, 56f, 296f, 440f, false)),
                assistantFloating = decodeBounds(json.optJSONObject("assistantFloating"), FloatingBounds(56f, 64f, 360f, 480f, false)),
                frontWindow = json.optString("frontWindow", "assistant"),
                fontSize = json.optInt("fontSize", 16).coerceIn(12, 24),
                lineHeight = json.optDouble("lineHeight", 1.82).toFloat().coerceIn(1.4f, 2.2f),
                readerTheme = theme,
            )
        }.getOrDefault(WorkspaceLayoutState())
    }

    private fun encodeBounds(b: FloatingBounds): JSONObject = JSONObject()
        .put("x", b.xDp.toDouble())
        .put("y", b.yDp.toDouble())
        .put("w", b.widthDp.toDouble())
        .put("h", b.heightDp.toDouble())
        .put("m", b.minimized)

    private fun decodeBounds(json: JSONObject?, fallback: FloatingBounds): FloatingBounds {
        if (json == null) return fallback
        return FloatingBounds(
            xDp = json.optDouble("x", fallback.xDp.toDouble()).toFloat(),
            yDp = json.optDouble("y", fallback.yDp.toDouble()).toFloat(),
            widthDp = json.optDouble("w", fallback.widthDp.toDouble()).toFloat().coerceAtLeast(220f),
            heightDp = json.optDouble("h", fallback.heightDp.toDouble()).toFloat().coerceAtLeast(200f),
            minimized = json.optBoolean("m", false),
        )
    }
}

class WorkspaceLayoutStore(context: Context) {
    private val prefs = context.getSharedPreferences("study-workspace-layout-v1", Context.MODE_PRIVATE)
    fun load(): WorkspaceLayoutState = WorkspaceLayoutMath.decode(prefs.getString("layout", null))
    fun save(state: WorkspaceLayoutState) {
        prefs.edit().putString("layout", WorkspaceLayoutMath.encode(state)).apply()
    }
}
