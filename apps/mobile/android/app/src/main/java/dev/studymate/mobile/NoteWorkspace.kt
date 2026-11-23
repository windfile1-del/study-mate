package dev.studymate.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun WorkspaceTabBar(
    state: StudyUi,
    videoTitle: String,
    hasActiveVideo: Boolean,
    onSelectHome: () -> Unit,
    onSelectVideo: () -> Unit,
    onDockVideo: () -> Unit,
    onSelectNote: (String) -> Unit,
    onCloseNote: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = StudyColors.SurfaceSidebar,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                WorkspaceTabChip(
                    title = "工作台",
                    selected = state.selectedTab == 0 && (state.showHome || state.note == null),
                    onClick = onSelectHome,
                    onClose = null,
                )
                if (hasActiveVideo && !state.videoDocked) {
                    WorkspaceTabChip(
                        title = videoTitle.ifBlank { "课程视频" },
                        selected = state.selectedTab == 3 && !state.showHome,
                        onClick = onSelectVideo,
                        trailingLabel = "⇥",
                        onTrailingClick = onDockVideo,
                        onClose = null,
                    )
                }
                val activePath = state.note?.optString("path")
                state.openTabs.forEach { path ->
                    val name = path.substringAfterLast('/').removeSuffix(".md")
                    WorkspaceTabChip(
                        title = name,
                        selected = state.selectedTab == 0 && !state.showHome && activePath == path,
                        onClick = { onSelectNote(path) },
                        onClose = { onCloseNote(path) },
                    )
                }
            }
            HorizontalDivider(color = StudyColors.Line)
        }
    }
}

@Composable
fun WorkspaceTabChip(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    trailingLabel: String? = null,
    onTrailingClick: (() -> Unit)? = null,
    onClose: (() -> Unit)? = null,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(9.dp),
        color = if (selected) StudyColors.SurfacePaper else StudyColors.BgSubtle,
        border = BorderStroke(1.dp, if (selected) StudyColors.AccentBorder else StudyColors.Line),
        shadowElevation = if (selected) 1.dp else 0.dp,
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp, end = if (onClose != null || onTrailingClick != null) 6.dp else 10.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.labelMedium.copy(
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = if (selected) StudyColors.Accent else StudyColors.InkSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 150.dp),
            )
            if (trailingLabel != null && onTrailingClick != null) {
                Text(
                    trailingLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = StudyColors.InkTertiary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .clickable(onClick = onTrailingClick)
                        .padding(horizontal = 4.dp, vertical = 1.dp),
                )
            }
            if (onClose != null) {
                Text(
                    "×",
                    style = MaterialTheme.typography.labelMedium,
                    color = StudyColors.InkTertiary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .clickable(onClick = onClose)
                        .padding(horizontal = 4.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WorkspaceHomePane(
    model: StudyViewModel,
    state: StudyUi,
    onOpenVideos: () -> Unit,
    onOpenOffline: () -> Unit,
    onOpenNav: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(StudyColors.BgApp)
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = StudyColors.SurfacePaper,
            border = BorderStroke(1.dp, StudyColors.Line),
            shadowElevation = 2.dp,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "AI-NATIVE STUDY WORKBENCH",
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                    color = StudyColors.Accent,
                )
                Text(
                    "专注眼前这课，留下真正理解的笔记。",
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                    color = StudyColors.InkPrimary,
                )
                Text(
                    "支持多笔记标签页、分栏对照、自由拖拽调整窗口大小、悬浮小窗与电脑双向接力。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = StudyColors.InkSecondary,
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(onClick = model::continueLearning) {
                        Text("继续电脑学习")
                    }
                    OutlinedButton(onClick = onOpenVideos) {
                        Text("课程视频 (${state.videos.size})")
                    }
                    OutlinedButton(onClick = onOpenNav) {
                        Text("浏览知识库 (${state.notes.size})")
                    }
                    TextButton(onClick = onOpenOffline) {
                        Text("同步离线笔记")
                    }
                }
            }
        }

        if (state.notes.isNotEmpty()) {
            Text(
                "快速打开笔记",
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                color = StudyColors.InkPrimary,
            )
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                state.notes.take(8).forEach { note ->
                    Surface(
                        onClick = { model.openNote(note.path) },
                        shape = RoundedCornerShape(10.dp),
                        color = StudyColors.SurfacePaper,
                        border = BorderStroke(1.dp, StudyColors.Line),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    note.name.removeSuffix(".md"),
                                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                                    color = StudyColors.InkPrimary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    note.path,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = StudyColors.InkTertiary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Text("打开 →", style = MaterialTheme.typography.labelMedium, color = StudyColors.Accent)
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TypographySettingsDropdown(
    expanded: Boolean,
    fontSize: Int,
    lineHeight: Float,
    readerTheme: String,
    onDismiss: () -> Unit,
    onFontSize: (Int) -> Unit,
    onLineHeight: (Float) -> Unit,
    onReaderTheme: (String) -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.padding(12.dp).width(220.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("阅读排版设置", style = MaterialTheme.typography.titleSmall, color = StudyColors.InkPrimary)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("字号 ${fontSize}px", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(
                        onClick = { onFontSize((fontSize - 1).coerceAtLeast(12)) },
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                    ) { Text("A-") }
                    OutlinedButton(
                        onClick = { onFontSize((fontSize + 1).coerceAtMost(24)) },
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp),
                    ) { Text("A+") }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                listOf(1.65f to "紧凑", 1.82f to "舒适", 2.0f to "宽松").forEach { (lh, label) ->
                    TopbarTogglePill(
                        text = label,
                        active = kotlin.math.abs(lineHeight - lh) < 0.05f,
                        onClick = { onLineHeight(lh) },
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                listOf("paper" to "纯白", "warm" to "暖纸", "mint" to "青绿").forEach { (id, label) ->
                    TopbarTogglePill(
                        text = label,
                        active = readerTheme == id,
                        onClick = { onReaderTheme(id) },
                    )
                }
            }
        }
    }
}

@Composable
fun NotePaneContent(
    model: StudyViewModel,
    state: StudyUi,
    pane: String,
    layout: WorkspaceLayoutState,
    onUpdateLayout: (WorkspaceLayoutState) -> Unit,
    modifier: Modifier = Modifier,
    externalInkCommand: String = "",
    externalInkNonce: Int = 0,
) {
    val note = if (pane == "side") state.sideNote else state.note
    var typographyOpen by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    var scrollTopNonce by remember { mutableIntStateOf(0) }
    var localInkCommand by remember { mutableStateOf("") }
    var localInkNonce by remember { mutableIntStateOf(0) }

    LaunchedEffect(externalInkNonce) {
        if (pane == "main" && externalInkNonce > 0 && externalInkCommand.isNotBlank()) {
            localInkCommand = externalInkCommand
            localInkNonce++
        }
    }

    fun dispatchInk(cmd: String) {
        localInkCommand = cmd
        localInkNonce++
    }

    val hideToolbar = pane == "main" && layout.chromeCollapsed

    Column(modifier.background(StudyColors.SurfacePaper)) {
        if (note != null) {
            val path = note.getString("path")
            val content = note.getString("content")
            val contentHash = NoteInkStore.contentHash(content, note.optString("version"))
            if (!hideToolbar) {
                Surface(color = StudyColors.SurfaceTopbar) {
                    Column(Modifier.fillMaxWidth()) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(36.dp)
                                .padding(horizontal = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            if (pane == "main") {
                                ToolbarMiniButton(
                                    text = "←",
                                    enabled = state.canBack,
                                    onClick = { model.stepHistory(-1) },
                                )
                                ToolbarMiniButton(
                                    text = "→",
                                    enabled = state.canForward,
                                    onClick = { model.stepHistory(1) },
                                )
                            }
                            Text(
                                path.substringAfterLast('/').removeSuffix(".md"),
                                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium),
                                color = StudyColors.InkSecondary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                            )
                            Row(
                                modifier = Modifier.horizontalScroll(rememberScrollState()),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                ToolbarMiniButton(text = "手写", onClick = { dispatchInk("toggleTempInk") })
                                ToolbarMiniButton(text = "+手写栏", onClick = { dispatchInk("addPad") })
                                Box {
                                    ToolbarMiniButton(
                                        text = "Aa",
                                        active = typographyOpen,
                                        onClick = { typographyOpen = !typographyOpen },
                                    )
                                    TypographySettingsDropdown(
                                        expanded = typographyOpen,
                                        fontSize = layout.fontSize,
                                        lineHeight = layout.lineHeight,
                                        readerTheme = layout.readerTheme,
                                        onDismiss = { typographyOpen = false },
                                        onFontSize = { onUpdateLayout(layout.copy(fontSize = it)) },
                                        onLineHeight = { onUpdateLayout(layout.copy(lineHeight = it)) },
                                        onReaderTheme = { onUpdateLayout(layout.copy(readerTheme = it)) },
                                    )
                                }
                                if (pane == "main") {
                                    ToolbarMiniButton(
                                        text = "专注",
                                        active = layout.chromeCollapsed,
                                        onClick = { onUpdateLayout(layout.copy(chromeCollapsed = true)) },
                                    )
                                }
                                Box {
                                    ToolbarMiniButton(text = "⋯", onClick = { moreOpen = true })
                                    DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                                        DropdownMenuItem(
                                            text = { Text("回到顶部") },
                                            onClick = { moreOpen = false; scrollTopNonce++ },
                                        )
                                        DropdownMenuItem(
                                            text = { Text("刷新笔记") },
                                            onClick = { moreOpen = false; model.refreshNote(pane) },
                                        )
                                        DropdownMenuItem(
                                            text = { Text(if (pane == "main") "移到侧栏" else "移回主区") },
                                            onClick = { moreOpen = false; model.dockNote(path, pane) },
                                        )
                                        DropdownMenuItem(
                                            text = { Text("清空临时手写") },
                                            onClick = { moreOpen = false; dispatchInk("clearTempInk") },
                                        )
                                    }
                                }
                            }
                        }
                        HorizontalDivider(color = StudyColors.Line)
                    }
                }
            }
            ReadingView(
                source = content,
                path = path,
                vaultId = state.vaultId,
                client = model.client,
                modifier = Modifier.fillMaxWidth().weight(1f),
                anchor = note.optString("anchor"),
                onNavigate = { base, target, wiki -> model.navigateInPane(base, target, wiki, pane) },
                fontSize = layout.fontSize,
                lineHeight = layout.lineHeight,
                readerTheme = layout.readerTheme,
                scrollTopNonce = scrollTopNonce,
                contentHash = contentHash,
                hideTools = hideToolbar,
                inkCommand = localInkCommand,
                inkCommandNonce = localInkNonce,
                inkSyncNonce = state.inkSyncNonce,
            )
        } else {
            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                Text(
                    "选择一篇笔记开始阅读，或点击「分栏」在这里并排对照。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = StudyColors.InkTertiary,
                )
            }
        }
    }
}

@Composable
fun ToolbarMiniButton(
    text: String,
    enabled: Boolean = true,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(7.dp),
        color = if (active) StudyColors.AccentSoft else StudyColors.BgSubtle,
        border = BorderStroke(1.dp, if (active) StudyColors.AccentBorder else StudyColors.Line),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
            color = when {
                !enabled -> StudyColors.InkMuted
                active -> StudyColors.Accent
                else -> StudyColors.InkSecondary
            },
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
        )
    }
}
