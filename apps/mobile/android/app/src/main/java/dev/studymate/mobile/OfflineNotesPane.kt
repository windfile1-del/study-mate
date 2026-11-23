package dev.studymate.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
internal fun OfflineNotesPane(
    library: OfflineLibrary,
    ui: OfflineUi,
    modifier: Modifier,
    layout: WorkspaceLayoutState,
    onUpdateLayout: (WorkspaceLayoutState) -> Unit,
    externalInkCommand: String = "",
    externalInkNonce: Int = 0,
    onReadingActive: (Boolean) -> Unit = {},
    connect: () -> Unit,
    sync: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<OfflineNote?>(null) }
    var anchor by remember { mutableStateOf("") }
    var linkError by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    var scrollTopNonce by remember { mutableIntStateOf(0) }
    var typographyOpen by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    var localInkCommand by remember { mutableStateOf("") }
    var localInkNonce by remember { mutableIntStateOf(0) }

    val current = selected?.takeIf { it in ui.notes }
    val reader = current?.let { library.reader(it.source) }
    val isReading = current != null && reader != null

    LaunchedEffect(isReading) {
        onReadingActive(isReading)
    }
    DisposableEffect(Unit) {
        onDispose { onReadingActive(false) }
    }

    LaunchedEffect(externalInkNonce) {
        if (isReading && externalInkNonce > 0 && externalInkCommand.isNotBlank()) {
            localInkCommand = externalInkCommand
            localInkNonce++
        }
    }

    fun dispatchInk(cmd: String) {
        localInkCommand = cmd
        localInkNonce++
    }

    if (isReading && current != null && reader != null) {
        val noteObj = remember(current.path, current.source, reader.revision) {
            reader.note(current.path)
        }
        val content = noteObj.getString("content")
        val contentHash = NoteInkStore.contentHash(content, noteObj.optString("version"))
        val scopeId = library.vaultIdForSource(current.source) ?: current.source

        Column(modifier.fillMaxSize().background(StudyColors.SurfacePaper)) {
            if (!layout.chromeCollapsed) {
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
                            ToolbarMiniButton(text = "← 列表", onClick = { selected = null; linkError = "" })
                            Text(
                                current.path.substringAfterLast('/').removeSuffix(".md"),
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
                                ToolbarMiniButton(
                                    text = "专注",
                                    active = layout.chromeCollapsed,
                                    onClick = { onUpdateLayout(layout.copy(chromeCollapsed = true)) },
                                )
                                Box {
                                    ToolbarMiniButton(text = "⋯", onClick = { moreOpen = true })
                                    DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                                        DropdownMenuItem(
                                            text = { Text("回到顶部") },
                                            onClick = { moreOpen = false; scrollTopNonce++ },
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
            if (linkError.isNotBlank()) {
                Text(
                    linkError,
                    style = MaterialTheme.typography.bodySmall,
                    color = StudyColors.WarmInk,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
            OfflineReadingView(
                source = content,
                path = current.path,
                sourceId = scopeId,
                reader = reader,
                modifier = Modifier.fillMaxWidth().weight(1f),
                anchor = anchor,
                fontSize = layout.fontSize,
                lineHeight = layout.lineHeight,
                readerTheme = layout.readerTheme,
                scrollTopNonce = scrollTopNonce,
                contentHash = contentHash,
                hideTools = layout.chromeCollapsed,
                inkCommand = localInkCommand,
                inkCommandNonce = localInkNonce,
                inkSyncNonce = ui.inkSyncNonce,
            ) { base, target, wiki ->
                scope.launch {
                    runCatching { reader.resolve(JSONObject().put("base", base).put("target", target).put("wiki", wiki)) }
                        .onSuccess { resolved ->
                            selected = OfflineNote(current.source, resolved.getString("path"))
                            anchor = resolved.getString("anchor")
                            linkError = ""
                        }.onFailure { linkError = it.message ?: "目标笔记未同步" }
                }
            }
        }
        return
    }

    Column(modifier.fillMaxWidth().background(StudyColors.BgApp).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Surface(
            shape = RoundedCornerShape(12.dp),
            color = StudyColors.SurfacePaper,
            border = BorderStroke(1.dp, StudyColors.Line),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "同步笔记",
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = StudyColors.InkPrimary,
                    )
                    FilledTonalButton(onClick = sync, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                        Text("立即刷新", style = MaterialTheme.typography.labelMedium)
                    }
                }
                if (ui.lanStatus.isNotBlank()) Text(ui.lanStatus, style = MaterialTheme.typography.bodySmall, color = StudyColors.InkSecondary)
                if (ui.driveStatus.isNotBlank()) Text(ui.driveStatus, style = MaterialTheme.typography.bodySmall, color = StudyColors.InkSecondary)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    if (ui.email.isBlank()) {
                        TextButton(onClick = connect) { Text("连接 Google Drive") }
                    } else {
                        Text(ui.email, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = StudyColors.InkTertiary)
                        TextButton(onClick = { scope.launch { library.forgetDrive() } }) { Text("断开 Drive") }
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))

        if (ui.notes.isEmpty()) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = StudyColors.SurfacePaper,
                border = BorderStroke(1.dp, StudyColors.Line),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "在电脑「平板连接 → 同步笔记到平板」勾选笔记，下载后即可离线阅读。",
                    Modifier.padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = StudyColors.InkSecondary,
                )
            }
        } else {
            OutlinedTextField(
                value = filter,
                onValueChange = { filter = it },
                placeholder = { Text("筛选已同步笔记…") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
            val filtered = remember(ui.notes, filter) {
                if (filter.isBlank()) ui.notes
                else ui.notes.filter { it.path.contains(filter.trim(), ignoreCase = true) }
            }
            LazyColumn(
                Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(filtered, key = { "${it.source}/${it.path}" }) { note ->
                    Surface(
                        onClick = { selected = note; anchor = ""; linkError = "" },
                        shape = RoundedCornerShape(10.dp),
                        color = StudyColors.SurfacePaper,
                        border = BorderStroke(1.dp, StudyColors.Line),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                note.path,
                                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                                color = StudyColors.InkPrimary,
                                modifier = Modifier.weight(1f),
                            )
                            Text("阅读 →", style = MaterialTheme.typography.labelMedium, color = StudyColors.Accent)
                        }
                    }
                }
            }
        }
    }
}
