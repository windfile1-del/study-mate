package dev.studymate.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

@Composable
fun HorizontalResizeHandle(
    label: String,
    onDeltaDp: (Float) -> Unit,
    onReset: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val latestDelta by rememberUpdatedState(onDeltaDp)
    val latestReset by rememberUpdatedState(onReset)
    var active by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .width(10.dp)
            .fillMaxHeight()
            .semantics { contentDescription = label }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { latestReset() })
            }
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragStart = { active = true },
                    onDragEnd = { active = false },
                    onDragCancel = { active = false },
                    onHorizontalDrag = { change, dragAmount ->
                        change.consume()
                        latestDelta(with(density) { dragAmount.toDp().value })
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .width(if (active) 2.dp else 1.dp)
                .fillMaxHeight()
                .background(if (active) StudyColors.Accent else StudyColors.Line),
        )
        Box(
            Modifier
                .width(4.dp)
                .height(34.dp)
                .clip(RoundedCornerShape(99.dp))
                .background(if (active) StudyColors.Accent else StudyColors.LineStrong),
        )
    }
}

@Composable
fun VerticalResizeHandle(
    label: String,
    onDeltaDp: (Float) -> Unit,
    onReset: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val latestDelta by rememberUpdatedState(onDeltaDp)
    val latestReset by rememberUpdatedState(onReset)
    var active by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .height(10.dp)
            .fillMaxWidth()
            .semantics { contentDescription = label }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { latestReset() })
            }
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onDragStart = { active = true },
                    onDragEnd = { active = false },
                    onDragCancel = { active = false },
                    onVerticalDrag = { change, dragAmount ->
                        change.consume()
                        latestDelta(with(density) { dragAmount.toDp().value })
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .height(if (active) 2.dp else 1.dp)
                .fillMaxWidth()
                .background(if (active) StudyColors.Accent else StudyColors.Line),
        )
        Box(
            Modifier
                .width(36.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(99.dp))
                .background(if (active) StudyColors.Accent else StudyColors.LineStrong),
        )
    }
}

@Composable
fun FloatingWindowHost(
    title: String,
    bounds: FloatingBounds,
    containerWidthDp: Float,
    containerHeightDp: Float,
    isFront: Boolean,
    onFocus: () -> Unit,
    onBoundsChange: (FloatingBounds) -> Unit,
    onDock: (() -> Unit)?,
    onMinimize: () -> Unit,
    onClose: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val density = LocalDensity.current
    val latestBounds by rememberUpdatedState(bounds)
    val latestOnChange by rememberUpdatedState(onBoundsChange)
    val latestFocus by rememberUpdatedState(onFocus)
    val clamped = WorkspaceLayoutMath.clampFloatingBounds(bounds, containerWidthDp, containerHeightDp)
    val offsetX = with(density) { clamped.xDp.dp.roundToPx() }
    val offsetY = with(density) { clamped.yDp.dp.roundToPx() }

    Surface(
        modifier = Modifier
            .offset { IntOffset(offsetX, offsetY) }
            .width(clamped.widthDp.dp)
            .height(clamped.heightDp.dp)
            .pointerInput(Unit) {
                detectTapGestures(onPress = { latestFocus() })
            },
        shape = RoundedCornerShape(14.dp),
        color = StudyColors.SurfacePaper,
        shadowElevation = if (isFront) 16.dp else 8.dp,
        border = BorderStroke(1.dp, if (isFront) StudyColors.AccentBorder else StudyColors.LineStrong),
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(42.dp)
                        .background(StudyColors.SurfaceSidebar)
                        .pointerInput(containerWidthDp, containerHeightDp) {
                            detectDragGestures(
                                onDragStart = { latestFocus() },
                                onDrag = { change, dragAmount ->
                                    change.consume()
                                    val dx = with(density) { dragAmount.x.toDp().value }
                                    val dy = with(density) { dragAmount.y.toDp().value }
                                    val cur = latestBounds
                                    latestOnChange(
                                        WorkspaceLayoutMath.clampFloatingBounds(
                                            cur.copy(xDp = cur.xDp + dx, yDp = cur.yDp + dy),
                                            containerWidthDp,
                                            containerHeightDp,
                                        ),
                                    )
                                },
                            )
                        }
                        .padding(start = 12.dp, end = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(if (isFront) StudyColors.Accent else StudyColors.InkMuted),
                    )
                    Text(
                        title,
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                        color = StudyColors.InkPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(start = 4.dp),
                    )
                    if (onDock != null) {
                        WindowTextChip("停靠", onClick = onDock)
                    }
                    WindowTextChip("缩小", onClick = onMinimize)
                    WindowTextChip("隐藏", onClick = onClose)
                }
                HorizontalDivider(color = StudyColors.Line)
                Column(Modifier.fillMaxWidth().weight(1f), content = content)
            }

            // Right-edge horizontal resize strip
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .width(10.dp)
                    .fillMaxHeight()
                    .padding(vertical = 44.dp)
                    .pointerInput(containerWidthDp, containerHeightDp) {
                        detectDragGestures(
                            onDragStart = { latestFocus() },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                val dx = with(density) { dragAmount.x.toDp().value }
                                val cur = latestBounds
                                latestOnChange(
                                    WorkspaceLayoutMath.clampFloatingBounds(
                                        cur.copy(widthDp = cur.widthDp + dx),
                                        containerWidthDp,
                                        containerHeightDp,
                                    ),
                                )
                            },
                        )
                    },
            )

            // Bottom-edge vertical resize strip
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .height(10.dp)
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp)
                    .pointerInput(containerWidthDp, containerHeightDp) {
                        detectDragGestures(
                            onDragStart = { latestFocus() },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                val dy = with(density) { dragAmount.y.toDp().value }
                                val cur = latestBounds
                                latestOnChange(
                                    WorkspaceLayoutMath.clampFloatingBounds(
                                        cur.copy(heightDp = cur.heightDp + dy),
                                        containerWidthDp,
                                        containerHeightDp,
                                    ),
                                )
                            },
                        )
                    },
            )

            // Bottom-right corner diagonal resize handle
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(28.dp)
                    .semantics { contentDescription = "缩放$title" }
                    .pointerInput(containerWidthDp, containerHeightDp) {
                        detectDragGestures(
                            onDragStart = { latestFocus() },
                            onDrag = { change, dragAmount ->
                                change.consume()
                                val dx = with(density) { dragAmount.x.toDp().value }
                                val dy = with(density) { dragAmount.y.toDp().value }
                                val cur = latestBounds
                                latestOnChange(
                                    WorkspaceLayoutMath.clampFloatingBounds(
                                        cur.copy(widthDp = cur.widthDp + dx, heightDp = cur.heightDp + dy),
                                        containerWidthDp,
                                        containerHeightDp,
                                    ),
                                )
                            },
                        )
                    },
                contentAlignment = Alignment.BottomEnd,
            ) {
                Text(
                    "◢",
                    fontSize = 12.sp,
                    color = StudyColors.Accent,
                    modifier = Modifier.padding(end = 4.dp, bottom = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun WindowTextChip(label: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(6.dp),
        color = StudyColors.BgSubtle,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = StudyColors.InkSecondary,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Composable
fun MinimizedFloatingPill(
    label: String,
    onRestore: () -> Unit,
    onClose: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(99.dp),
        color = StudyColors.SurfacePaper,
        shadowElevation = 6.dp,
        border = BorderStroke(1.dp, StudyColors.AccentBorder),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = StudyColors.Accent,
                modifier = Modifier.clickable(onClick = onRestore),
            )
            Surface(
                onClick = onClose,
                shape = CircleShape,
                color = StudyColors.BgSubtle,
            ) {
                Text(
                    "×",
                    style = MaterialTheme.typography.labelSmall,
                    color = StudyColors.InkTertiary,
                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
fun WorkspaceTopbar(
    state: StudyUi,
    layout: WorkspaceLayoutState,
    wide: Boolean,
    showOffline: Boolean,
    showConnections: Boolean,
    canFocus: Boolean,
    onToggleNav: () -> Unit,
    onFloatNav: () -> Unit,
    onToggleAssistant: () -> Unit,
    onFloatAssistant: () -> Unit,
    onToggleCompactSplit: () -> Unit,
    onToggleFocus: () -> Unit,
    onSelectTab: (Int) -> Unit,
    onContinueLearning: () -> Unit,
    onToggleOffline: () -> Unit,
    onToggleConnections: () -> Unit,
) {
    var floatMenu by remember { mutableStateOf(false) }
    var moreMenu by remember { mutableStateOf(false) }
    val inStudy = (state.connected || state.offline) && !showOffline && !showConnections

    Surface(
        color = StudyColors.SurfaceTopbar,
        shadowElevation = 1.dp,
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (inStudy) {
                    val navOpen = wide && layout.navMode == PanelMode.DOCKED
                    TopbarTogglePill(
                        text = "目录",
                        active = navOpen,
                        onClick = onToggleNav,
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier.weight(1f, fill = false),
                ) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    state.connected -> StudyColors.Connected
                                    state.offline -> StudyColors.WarmInk
                                    else -> StudyColors.InkMuted
                                },
                            ),
                    )
                    Text(
                        "Study Mate",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                        color = StudyColors.InkPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                Spacer(Modifier.weight(1f))

                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (inStudy) {
                        if (wide) {
                            TopbarTogglePill(
                                text = if (layout.assistantMode == PanelMode.DOCKED) "伴学" else "伴学+",
                                active = layout.assistantMode == PanelMode.DOCKED,
                                onClick = onToggleAssistant,
                            )
                            Box {
                                TopbarTogglePill(
                                    text = "浮窗 ▾",
                                    active = layout.navMode == PanelMode.FLOATING || layout.assistantMode == PanelMode.FLOATING,
                                    onClick = { floatMenu = true },
                                )
                                DropdownMenu(expanded = floatMenu, onDismissRequest = { floatMenu = false }) {
                                    DropdownMenuItem(
                                        text = { Text(if (layout.navMode == PanelMode.FLOATING) "关闭目录浮窗" else "目录悬浮窗") },
                                        onClick = { floatMenu = false; onFloatNav() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(if (layout.assistantMode == PanelMode.FLOATING) "关闭伴学浮窗" else "伴学悬浮窗") },
                                        onClick = { floatMenu = false; onFloatAssistant() },
                                    )
                                }
                            }
                        } else {
                            TopbarTogglePill(
                                text = "笔记",
                                active = state.selectedTab == 0 || state.selectedTab == 2,
                                onClick = { onSelectTab(0) },
                            )
                            TopbarTogglePill(
                                text = "对话",
                                active = state.selectedTab == 1,
                                onClick = { onSelectTab(1) },
                            )
                            TopbarTogglePill(
                                text = "视频",
                                active = state.selectedTab == 3,
                                onClick = { onSelectTab(3) },
                            )
                            TopbarTogglePill(
                                text = if (layout.compactSplit) "单屏" else "分屏",
                                active = layout.compactSplit,
                                onClick = onToggleCompactSplit,
                            )
                        }
                    }

                    if (canFocus) {
                        TopbarTogglePill(
                            text = "专注",
                            active = layout.chromeCollapsed,
                            onClick = onToggleFocus,
                        )
                    }

                    if (wide) {
                        TextButton(
                            onClick = onToggleOffline,
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                            modifier = Modifier.height(32.dp),
                        ) {
                            Text(if (showOffline) "返回学习" else "同步笔记", style = MaterialTheme.typography.labelMedium)
                        }
                        TextButton(
                            onClick = onToggleConnections,
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp),
                            modifier = Modifier.height(32.dp),
                        ) {
                            Text(if (showConnections) "返回" else "电脑连接", style = MaterialTheme.typography.labelMedium)
                        }
                    } else {
                        Box {
                            TopbarTogglePill(
                                text = "更多 ▾",
                                active = showOffline || showConnections,
                                onClick = { moreMenu = true },
                            )
                            DropdownMenu(expanded = moreMenu, onDismissRequest = { moreMenu = false }) {
                                if (inStudy) {
                                    DropdownMenuItem(
                                        text = { Text("接续电脑学习") },
                                        onClick = { moreMenu = false; onContinueLearning() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(if (layout.navMode == PanelMode.FLOATING) "关闭目录浮窗" else "目录悬浮窗") },
                                        onClick = { moreMenu = false; onFloatNav() },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(if (layout.assistantMode == PanelMode.FLOATING) "关闭伴学浮窗" else "伴学悬浮窗") },
                                        onClick = { moreMenu = false; onFloatAssistant() },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(if (showOffline) "返回学习" else "同步笔记") },
                                    onClick = { moreMenu = false; onToggleOffline() },
                                )
                                DropdownMenuItem(
                                    text = { Text(if (showConnections) "返回" else "电脑连接") },
                                    onClick = { moreMenu = false; onToggleConnections() },
                                )
                            }
                        }
                    }
                }
            }
            HorizontalDivider(color = StudyColors.Line)
        }
    }
}

@Composable
fun CollapsedChromeOverlay(
    onExpand: () -> Unit,
    onToggleTempInk: () -> Unit,
    onAddPad: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(99.dp),
        color = Color(0xECFFFFFF),
        shadowElevation = 6.dp,
        border = BorderStroke(1.dp, StudyColors.AccentBorder),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TopbarTogglePill(text = "手写", active = false, onClick = onToggleTempInk)
            TopbarTogglePill(text = "+手写栏", active = false, onClick = onAddPad)
            TopbarTogglePill(text = "展开菜单 ▾", active = true, onClick = onExpand)
        }
    }
}

@Composable
fun TopbarTogglePill(
    text: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = if (active) StudyColors.AccentSoft else StudyColors.BgSubtle,
        border = BorderStroke(1.dp, if (active) StudyColors.AccentBorder else StudyColors.Line),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall.copy(
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
            ),
            color = if (active) StudyColors.Accent else StudyColors.InkSecondary,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
        )
    }
}

@Composable
fun WorkspaceStatusBar(
    state: StudyUi,
    layout: WorkspaceLayoutState,
    wide: Boolean,
) {
    Surface(color = StudyColors.SurfaceTopbar) {
        Column(Modifier.fillMaxWidth()) {
            HorizontalDivider(color = StudyColors.Line)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 5.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    buildString {
                        append(if (state.connected) "局域网已连接" else if (state.offline) "离线只读模式" else "待连接")
                        append(" · 已开 ${state.openTabs.size + state.sideTabs.size} 篇笔记")
                        if (wide) {
                            append(" · 栏宽 ${layout.navWidthDp.roundToInt()}/${layout.companionWidthDp.roundToInt()}dp")
                        }
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = StudyColors.InkTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "字号 ${layout.fontSize}px · 只读学习",
                    style = MaterialTheme.typography.labelSmall,
                    color = StudyColors.InkMuted,
                )
            }
        }
    }
}
