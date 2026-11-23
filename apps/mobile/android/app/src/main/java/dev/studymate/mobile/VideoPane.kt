package dev.studymate.mobile

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.ui.PlayerView

fun videoTime(seconds: Double): String {
    val value = seconds.toLong().coerceAtLeast(0)
    return if (value >= 3600) "%d:%02d:%02d".format(value / 3600, value / 60 % 60, value % 60)
    else "%d:%02d".format(value / 60, value % 60)
}

@androidx.media3.common.util.UnstableApi
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun VideoPane(
    model: StudyViewModel,
    state: StudyUi,
    modifier: Modifier = Modifier,
    inSideDock: Boolean = false,
) {
    val video by model.playback.ui.collectAsStateWithLifecycle()
    val playback = model.playback
    val activity = LocalContext.current as? android.app.Activity

    DisposableEffect(video.fullscreen, activity) {
        val controller = activity?.let { WindowCompat.getInsetsController(it.window, it.window.decorView) }
        if (video.fullscreen) {
            controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { if (video.fullscreen) controller?.show(WindowInsetsCompat.Type.systemBars()) }
    }
    BackHandler(video.fullscreen) { playback.fullscreen(false) }

    BoxWithConstraints(modifier.fillMaxWidth().background(StudyColors.SurfacePaper)) {
        val videoHeight = minOf(maxWidth * 9 / 16, maxHeight * (if (inSideDock) 0.54f else 0.46f))
        Column(
            Modifier.fillMaxSize().padding(if (video.fullscreen) 8.dp else 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        if (video.sourceId.isBlank()) "课程学习" else video.title,
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = StudyColors.InkPrimary,
                        maxLines = 2,
                    )
                    Text(
                        "电脑提供视频 · 平板独立记录进度",
                        style = MaterialTheme.typography.labelSmall,
                        color = StudyColors.InkTertiary,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!video.fullscreen && video.sourceId.isNotBlank()) {
                        TextButton(onClick = { model.dockVideo(!inSideDock) }) {
                            Text(if (inSideDock) "移回主区" else "移到侧栏")
                        }
                    }
                    TextButton(
                        onClick = { playback.fullscreen(!video.fullscreen) },
                        enabled = video.sourceId.isNotBlank(),
                    ) {
                        Text(if (video.fullscreen) "退出全屏" else "全屏")
                    }
                }
            }

            if (video.sourceId.isNotBlank()) {
                val playerModifier = if (video.fullscreen) {
                    Modifier.fillMaxWidth().weight(1f)
                } else {
                    Modifier.fillMaxWidth().height(videoHeight.coerceAtLeast(80.dp))
                }
                // A single retained player is rebound when moving between full-screen and split panes.
                AndroidView(
                    factory = { context ->
                        PlayerView(context).apply {
                            tag = "study-player"
                            layoutParams = ViewGroup.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            )
                            useController = false
                        }
                    },
                    update = { view ->
                        view.player = playback.player
                        view.keepScreenOn = video.playing || video.loading
                    },
                    onRelease = { it.player = null },
                    modifier = playerModifier.background(Color.Black),
                )
                if (video.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (video.error.isNotBlank()) {
                    Text(video.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = playback::retry) { Text("重试播放") }
                }
                var dragging by remember(video.sourceId) { mutableStateOf<Float?>(null) }
                Text(
                    "${videoTime(dragging?.toDouble() ?: video.position)} / ${videoTime(video.duration)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = StudyColors.InkSecondary,
                )
                Slider(
                    modifier = Modifier.testTag("video-seek"),
                    value = dragging ?: video.position.toFloat().coerceIn(0f, video.duration.toFloat().coerceAtLeast(1f)),
                    onValueChange = { dragging = it },
                    valueRange = 0f..video.duration.toFloat().coerceAtLeast(1f),
                    enabled = video.duration > 0,
                    onValueChangeFinished = {
                        dragging?.let { playback.seek(it.toDouble()) }
                        dragging = null
                    },
                )
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilledTonalButton(
                        onClick = playback::toggle,
                        enabled = playback.player != null && video.error.isBlank(),
                    ) {
                        Text(if (video.playing) "暂停" else "播放")
                    }
                    TextButton(onClick = { playback.seek(video.position - 10) }, enabled = video.duration > 0) {
                        Text("后退10秒")
                    }
                    TextButton(onClick = { playback.seek(video.position + 10) }, enabled = video.duration > 0) {
                        Text("前进10秒")
                    }
                    var speedMenu by remember { mutableStateOf(false) }
                    Box {
                        TextButton(onClick = { speedMenu = true }) { Text("${video.rate}× 倍速") }
                        DropdownMenu(expanded = speedMenu, onDismissRequest = { speedMenu = false }) {
                            listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f).forEach { rate ->
                                DropdownMenuItem(
                                    text = { Text("${rate}×") },
                                    onClick = {
                                        playback.speed(rate)
                                        speedMenu = false
                                    },
                                )
                            }
                        }
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton(onClick = model::askVideo, enabled = video.duration > 0) {
                        Text("就此刻提问")
                    }
                    TextButton(onClick = playback::handoff, enabled = video.duration > 0) {
                        Text("发回电脑续播")
                    }
                    TextButton(onClick = { model.continueLearning() }) {
                        Text("读取电脑进度")
                    }
                }
                if (video.notice.isNotBlank()) {
                    Text(video.notice, style = MaterialTheme.typography.bodySmall, color = StudyColors.Accent)
                }
            }

            if (!video.fullscreen && !inSideDock) {
                HorizontalDivider(color = StudyColors.Line)
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "电脑课程",
                        modifier = Modifier.padding(4.dp),
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = StudyColors.InkPrimary,
                    )
                    TextButton(onClick = { model.refreshVideos() }) { Text("刷新课程") }
                }
                if (state.videos.isEmpty()) {
                    Text(
                        "先在电脑打开本地视频或 B站课程，然后刷新。",
                        style = MaterialTheme.typography.bodySmall,
                        color = StudyColors.InkTertiary,
                    )
                }
                LazyColumn(
                    Modifier.fillMaxWidth().weight(1f),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.videos, key = { it.getString("id") }) { row ->
                        val checkpoint = row.optJSONObject("checkpoint")
                        val desktop = row.optJSONObject("desktop")
                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = StudyColors.BgSubtle,
                            border = BorderStroke(1.dp, StudyColors.Line),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(
                                Modifier.fillMaxWidth().padding(12.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    row.getString("title"),
                                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                                    color = StudyColors.InkPrimary,
                                    maxLines = 2,
                                )
                                Text(
                                    if (!row.optBoolean("supported")) "此来源请在电脑观看"
                                    else if (checkpoint != null) "平板上次看到 ${videoTime(checkpoint.optDouble("position"))}"
                                    else "${if (row.optString("kind") == "bilibili") "B站课程" else "本地视频"} · 尚未在平板播放",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = StudyColors.InkTertiary,
                                )
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    FilledTonalButton(
                                        enabled = row.optBoolean("supported"),
                                        onClick = { model.openVideo(row) },
                                    ) { Text("在平板播放") }
                                    if (desktop != null) {
                                        OutlinedButton(
                                            enabled = row.optBoolean("supported"),
                                            onClick = { model.openVideo(row, true) },
                                        ) { Text("接续电脑 ${videoTime(desktop.optDouble("position"))}") }
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
