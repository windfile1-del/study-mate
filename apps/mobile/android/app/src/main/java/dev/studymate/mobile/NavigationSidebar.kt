package dev.studymate.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private data class VisibleTreeRow(
    val node: NoteTreeNode,
    val depth: Int,
)

private fun flattenVisibleTree(
    nodes: List<NoteTreeNode>,
    expanded: Set<String>,
    depth: Int = 0,
): List<VisibleTreeRow> = buildList {
    for (node in nodes) {
        add(VisibleTreeRow(node, depth))
        if (node.isDirectory && node.path in expanded) {
            addAll(flattenVisibleTree(node.children, expanded, depth + 1))
        }
    }
}

@Composable
fun NavigationSidebar(
    model: StudyViewModel,
    state: StudyUi,
    query: String,
    onQueryChange: (String) -> Unit,
    onOpenNoteMain: (String) -> Unit,
    onOpenNoteSide: (String) -> Unit,
    onShowWorkspace: () -> Unit,
    onShowVideos: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var category by remember { mutableStateOf("notes") }
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val activePath = state.note?.optString("path").orEmpty()
    val sidePath = state.sideNote?.optString("path").orEmpty()

    Column(
        modifier = modifier
            .background(StudyColors.SurfaceSidebar)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // Quick global actions matching desktop NavigationPanel
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            SidebarQuickButton(
                label = "工作台",
                active = state.selectedTab == 0 && state.showHome,
                onClick = onShowWorkspace,
                modifier = Modifier.weight(1f),
            )
            SidebarQuickButton(
                label = "课程视频",
                active = state.selectedTab == 3 && !state.videoDocked,
                onClick = onShowVideos,
                modifier = Modifier.weight(1f),
            )
        }
        Surface(
            onClick = model::continueLearning,
            shape = RoundedCornerShape(8.dp),
            color = StudyColors.AccentSoft,
            border = BorderStroke(1.dp, StudyColors.AccentBorder),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                "继续电脑学习",
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = StudyColors.Accent,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }

        // Category segmented tabs (笔记 / 课程)
        Surface(
            shape = RoundedCornerShape(10.dp),
            color = StudyColors.BgSubtle,
            border = BorderStroke(1.dp, StudyColors.Line),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(Modifier.padding(3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                CategoryTabButton(
                    title = "笔记",
                    count = state.notes.size,
                    selected = category == "notes",
                    onClick = { category = "notes" },
                    modifier = Modifier.weight(1f),
                )
                CategoryTabButton(
                    title = "课程",
                    count = state.videos.size,
                    selected = category == "courses",
                    onClick = {
                        category = "courses"
                        model.refreshVideos()
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (category == "notes") {
            SearchInputBar(
                query = query,
                onQueryChange = onQueryChange,
                onSearch = { model.search(query) },
                onClear = {
                    onQueryChange("")
                    model.search("")
                },
            )

            if (query.isBlank() && state.noteTree.isNotEmpty()) {
                val visibleRows = remember(state.noteTree, expanded.toMap()) {
                    flattenVisibleTree(state.noteTree, expanded.filterValues { it }.keys)
                }
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    items(visibleRows, key = { (if (it.node.isDirectory) "dir:" else "file:") + it.node.path }) { row ->
                        val node = row.node
                        val indent = (row.depth * 14).dp
                        if (node.isDirectory) {
                            val isOpen = expanded[node.path] == true
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable { expanded[node.path] = !isOpen }
                                    .padding(start = 6.dp + indent, end = 8.dp, top = 7.dp, bottom = 7.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text(
                                    if (isOpen) "▾" else "▸",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = StudyColors.InkTertiary,
                                )
                                Text(
                                    node.name,
                                    style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                                    color = StudyColors.InkSecondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        } else {
                            val selected = activePath == node.path
                            val inSide = sidePath == node.path
                            NoteTreeFileRow(
                                name = node.name.removeSuffix(".md"),
                                path = node.path,
                                selected = selected,
                                inSide = inSide,
                                indent = indent,
                                onOpenMain = { onOpenNoteMain(node.path) },
                                onOpenSide = { onOpenNoteSide(node.path) },
                            )
                        }
                    }
                }
            } else {
                SearchNoteList(
                    notes = state.notes,
                    activePath = activePath,
                    sidePath = sidePath,
                    onOpenMain = onOpenNoteMain,
                    onOpenSide = onOpenNoteSide,
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
            }
        } else {
            // Courses quick list in sidebar
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("电脑课程 (${state.videos.size})", style = MaterialTheme.typography.labelMedium, color = StudyColors.InkTertiary)
                TextButton(onClick = { model.refreshVideos() }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                    Text("刷新", style = MaterialTheme.typography.labelSmall)
                }
            }
            if (state.videos.isEmpty()) {
                Text(
                    "在电脑打开本地视频或 B站课程后，点「刷新」即可在此观看。",
                    style = MaterialTheme.typography.bodySmall,
                    color = StudyColors.InkTertiary,
                    modifier = Modifier.padding(8.dp),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(state.videos, key = { it.getString("id") }) { row ->
                        val supported = row.optBoolean("supported")
                        val desktop = row.optJSONObject("desktop")
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = StudyColors.SurfacePaper,
                            border = BorderStroke(1.dp, StudyColors.Line),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    row.getString("title"),
                                    style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                                    color = StudyColors.InkPrimary,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    TextButton(
                                        enabled = supported,
                                        onClick = { model.openVideo(row) },
                                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                                    ) {
                                        Text(if (supported) "播放" else "仅电脑", style = MaterialTheme.typography.labelSmall)
                                    }
                                    if (desktop != null && supported) {
                                        TextButton(
                                            onClick = { model.openVideo(row, true) },
                                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                                        ) {
                                            Text("接续 ${videoTime(desktop.optDouble("position"))}", style = MaterialTheme.typography.labelSmall)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SidebarQuickButton(
    label: String,
    active: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = if (active) StudyColors.SurfacePaper else StudyColors.BgSubtle,
        border = BorderStroke(1.dp, if (active) StudyColors.AccentBorder else StudyColors.Line),
    ) {
        Box(Modifier.padding(vertical = 7.dp), contentAlignment = Alignment.Center) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium.copy(
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                ),
                color = if (active) StudyColors.Accent else StudyColors.InkSecondary,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun CategoryTabButton(
    title: String,
    count: Int,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(7.dp),
        color = if (selected) StudyColors.SurfacePaper else androidx.compose.ui.graphics.Color.Transparent,
        shadowElevation = if (selected) 1.dp else 0.dp,
    ) {
        Row(
            modifier = Modifier.padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "$title · $count",
                style = MaterialTheme.typography.labelMedium.copy(
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = if (selected) StudyColors.Accent else StudyColors.InkTertiary,
            )
        }
    }
}

@Composable
fun SearchInputBar(
    query: String,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    onClear: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = { Text("搜索知识库…", style = MaterialTheme.typography.bodySmall) },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodySmall,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onSearch() }),
            trailingIcon = if (query.isNotEmpty()) {
                {
                    TextButton(onClick = onClear, contentPadding = PaddingValues(horizontal = 6.dp)) {
                        Text("清除", style = MaterialTheme.typography.labelSmall)
                    }
                }
            } else null,
            modifier = Modifier.weight(1f),
        )
        FilledTonalButton(
            onClick = onSearch,
            contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp),
            shape = RoundedCornerShape(8.dp),
        ) {
            Text("搜索", style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun NoteTreeFileRow(
    name: String,
    path: String,
    selected: Boolean,
    inSide: Boolean,
    indent: androidx.compose.ui.unit.Dp,
    onOpenMain: () -> Unit,
    onOpenSide: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) StudyColors.AccentSoft else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onOpenMain)
            .padding(start = 8.dp + indent, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            name,
            style = MaterialTheme.typography.bodySmall.copy(
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            ),
            color = if (selected) StudyColors.Accent else StudyColors.InkPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Surface(
            onClick = onOpenSide,
            shape = RoundedCornerShape(6.dp),
            color = if (inSide) StudyColors.AccentSoft else StudyColors.BgSubtle,
        ) {
            Text(
                if (inSide) "侧栏中" else "分栏",
                style = MaterialTheme.typography.labelSmall,
                color = if (inSide) StudyColors.Accent else StudyColors.InkTertiary,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
fun SearchNoteList(
    notes: List<NoteRow>,
    activePath: String,
    sidePath: String,
    onOpenMain: (String) -> Unit,
    onOpenSide: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(notes, key = { it.path }) { note ->
            val selected = note.path == activePath
            Surface(
                onClick = { onOpenMain(note.path) },
                shape = RoundedCornerShape(9.dp),
                color = if (selected) StudyColors.AccentSoft else StudyColors.SurfacePaper,
                border = BorderStroke(1.dp, if (selected) StudyColors.AccentBorder else StudyColors.Line),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            note.name.removeSuffix(".md"),
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = if (selected) StudyColors.Accent else StudyColors.InkPrimary,
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
                        if (note.snippet.isNotBlank()) {
                            Text(
                                note.snippet.take(160),
                                style = MaterialTheme.typography.bodySmall,
                                color = StudyColors.InkSecondary,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Surface(
                        onClick = { onOpenSide(note.path) },
                        shape = RoundedCornerShape(6.dp),
                        color = if (note.path == sidePath) StudyColors.AccentSoft else StudyColors.BgSubtle,
                    ) {
                        Text(
                            "分栏",
                            style = MaterialTheme.typography.labelSmall,
                            color = StudyColors.InkTertiary,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 4.dp),
                        )
                    }
                }
            }
        }
    }
}
