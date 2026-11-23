package dev.studymate.mobile

import android.accounts.AccountManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.auth.api.identity.Identity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model: StudyViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            StudyMateTheme {
                StudyApp(model)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (Build.VERSION.SDK_INT < 37 || checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED) {
            model.resume()
        }
    }

    override fun onStop() {
        model.pauseConnection()
        super.onStop()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StudyApp(model: StudyViewModel) {
    val state by model.ui.collectAsStateWithLifecycle()
    val library = model.offlineLibrary
    val offline by library.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val layoutStore = remember { WorkspaceLayoutStore(context) }
    var layout by remember { mutableStateOf(layoutStore.load()) }
    fun updateLayout(next: WorkspaceLayoutState) {
        layout = next
        layoutStore.save(next)
    }

    var showOffline by remember { mutableStateOf(false) }
    var showConnections by remember { mutableStateOf(false) }
    var mobileDrawerOpen by remember { mutableStateOf(false) }
    var offlineReadingActive by remember { mutableStateOf(false) }
    var externalInkCommand by remember { mutableStateOf("") }
    var externalInkNonce by remember { mutableIntStateOf(0) }
    var foreground by remember { mutableStateOf(false) }
    var authorizing by remember { mutableStateOf(false) }

    fun triggerInk(command: String) {
        externalInkCommand = command
        externalInkNonce++
    }

    LifecycleResumeEffect(Unit) {
        foreground = true
        onPauseOrDispose { foreground = false }
    }

    val driveConsent = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        authorizing = false
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            runCatching { Identity.getAuthorizationClient(context).getAuthorizationResultFromIntent(result.data).accessToken }
                .onSuccess { token -> if (token != null) scope.launch { library.syncDrive(token, true) } }
                .onFailure { library.driveStatus("Google Drive 授权失败，请检查 Android OAuth 配置") }
        } else {
            library.driveStatus("Google Drive 授权未完成")
        }
    }

    fun refreshDrive(choose: Boolean, email: String = offline.email) {
        if (authorizing || email.isBlank()) return
        authorizing = true
        library.authorization(context, email).addOnSuccessListener { result ->
            val resolution = result.pendingIntent
            val token = result.accessToken
            if (resolution != null && choose) {
                runCatching { driveConsent.launch(IntentSenderRequest.Builder(resolution).build()) }
                    .onFailure {
                        authorizing = false
                        library.driveStatus("无法打开 Google 授权窗口")
                    }
            } else {
                authorizing = false
                if (token != null) scope.launch { library.syncDrive(token, choose) }
                else library.driveStatus("请断开 Drive 后重新授权")
            }
        }.addOnFailureListener {
            authorizing = false
            library.driveStatus("Google Drive 授权失败，请检查网络、Google Play 服务和应用 OAuth 配置")
        }
    }

    val accountPicker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            result.data?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)?.let { refreshDrive(true, it) }
        }
    }

    LaunchedEffect(offline.email, foreground) {
        if (offline.email.isBlank() || !foreground) return@LaunchedEffect
        delay(800)
        while (true) {
            refreshDrive(false)
            delay(60_000)
        }
    }

    val video by model.playback.ui.collectAsStateWithLifecycle()
    var pairing by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var localAllowed by remember { mutableStateOf(Build.VERSION.SDK_INT < 37) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        localAllowed = allowed
        if (allowed) model.resume()
    }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { model.pair(it) }
    }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 37) permission.launch("android.permission.ACCESS_LOCAL_NETWORK")
    }

    Surface(Modifier.fillMaxSize(), color = StudyColors.BgApp) {
        if (video.fullscreen && state.connected) {
            VideoPane(model, state, Modifier.fillMaxSize().safeDrawingPadding())
            return@Surface
        }

        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
            val wide = maxWidth >= 840.dp
            val medium = maxWidth >= 600.dp && !wide
            val onlineReadingActive = (state.connected || state.offline) &&
                !showOffline &&
                !showConnections &&
                state.selectedTab == 0 &&
                !state.showHome &&
                state.note != null &&
                (!wide || state.questionVideo == null || state.videoDocked)
            val readingNoteActive = onlineReadingActive || (showOffline && offlineReadingActive)
            val hideChrome = readingNoteActive && layout.chromeCollapsed
            BackHandler(hideChrome) { updateLayout(layout.copy(chromeCollapsed = false)) }

            Box(Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize()) {
                    if (!hideChrome) {
                        WorkspaceTopbar(
                            state = state,
                            layout = layout,
                            wide = wide,
                            showOffline = showOffline,
                            showConnections = showConnections,
                            canFocus = readingNoteActive,
                            onToggleNav = {
                                if (wide) {
                                    updateLayout(
                                        layout.copy(
                                            navMode = if (layout.navMode == PanelMode.DOCKED) PanelMode.HIDDEN else PanelMode.DOCKED,
                                        ),
                                    )
                                } else {
                                    if (layout.navMode == PanelMode.FLOATING) {
                                        updateLayout(layout.copy(navMode = PanelMode.HIDDEN))
                                    }
                                    mobileDrawerOpen = !mobileDrawerOpen
                                }
                            },
                            onFloatNav = {
                                mobileDrawerOpen = false
                                updateLayout(
                                    layout.copy(
                                        navMode = if (layout.navMode == PanelMode.FLOATING) PanelMode.HIDDEN else PanelMode.FLOATING,
                                        navFloating = layout.navFloating.copy(minimized = false),
                                        frontWindow = "nav",
                                    ),
                                )
                            },
                            onToggleAssistant = {
                                updateLayout(
                                    layout.copy(
                                        assistantMode = if (layout.assistantMode == PanelMode.DOCKED) PanelMode.HIDDEN else PanelMode.DOCKED,
                                    ),
                                )
                            },
                            onFloatAssistant = {
                                updateLayout(
                                    layout.copy(
                                        assistantMode = if (layout.assistantMode == PanelMode.FLOATING) PanelMode.HIDDEN else PanelMode.FLOATING,
                                        assistantFloating = layout.assistantFloating.copy(minimized = false),
                                        frontWindow = "assistant",
                                    ),
                                )
                            },
                            onToggleCompactSplit = {
                                updateLayout(layout.copy(compactSplit = !layout.compactSplit))
                            },
                            onToggleFocus = {
                                updateLayout(layout.copy(chromeCollapsed = !layout.chromeCollapsed))
                            },
                            onSelectTab = { tab ->
                                if (tab == 3) model.refreshVideos()
                                model.tab(tab)
                            },
                            onContinueLearning = model::continueLearning,
                            onToggleOffline = {
                                showOffline = !showOffline
                                showConnections = false
                                mobileDrawerOpen = false
                                if (showOffline) model.playback.pause()
                            },
                            onToggleConnections = {
                                showConnections = !showConnections
                                showOffline = false
                                mobileDrawerOpen = false
                            },
                        )
                    }

                if (state.error.isNotBlank()) {
                    Surface(
                        color = Color(0xFFFFF1F2),
                        border = BorderStroke(1.dp, Color(0xFFFECDD3)),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            state.error,
                            color = StudyColors.Danger,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
                if (state.working) LinearProgressIndicator(Modifier.fillMaxWidth())

                if (showOffline) {
                    OfflineNotesPane(
                        library = library,
                        ui = offline,
                        modifier = Modifier.weight(1f),
                        layout = layout,
                        onUpdateLayout = ::updateLayout,
                        externalInkCommand = externalInkCommand,
                        externalInkNonce = externalInkNonce,
                        onReadingActive = { offlineReadingActive = it },
                        connect = {
                            runCatching {
                                accountPicker.launch(
                                    AccountManager.newChooseAccountIntent(null, null, arrayOf("com.google"), null, null, null, null),
                                )
                            }.onFailure { library.driveStatus("无法选择 Google 账号，请检查设备上的 Google Play 服务") }
                        },
                        sync = {
                            if (state.connected) model.client?.let { scope.launch { library.syncLan(it) } }
                            if (offline.email.isNotBlank()) refreshDrive(false)
                        },
                    )
                } else if ((!state.connected && !state.offline) || showConnections) {
                    ConnectionsPane(
                        model = model,
                        state = state,
                        pairing = pairing,
                        onPairingChange = { pairing = it },
                        localAllowed = localAllowed,
                        onRequestLocal = { permission.launch("android.permission.ACCESS_LOCAL_NETWORK") },
                        onScanQr = {
                            scanner.launch(
                                ScanOptions()
                                    .setCaptureActivity(StudyMateScannerActivity::class.java)
                                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                    .setPrompt("将二维码完整放入取景框，距离约 15–30 厘米")
                                    .setBeepEnabled(false)
                                    .setBarcodeImageEnabled(false)
                                    .setOrientationLocked(false),
                            )
                        },
                        onCloseConnections = { showConnections = false },
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    )
                } else {
                    BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
                        val areaWidthDp = maxWidth.value
                        val areaHeightDp = maxHeight.value
                        val navDocked = wide && layout.navMode == PanelMode.DOCKED
                        val assistantDocked = wide && layout.assistantMode == PanelMode.DOCKED
                        val clampedCompanionWidth = if (assistantDocked) {
                            WorkspaceLayoutMath.clampCompanionWidth(
                                layout.companionWidthDp,
                                areaWidthDp,
                                if (navDocked) layout.navWidthDp else 0f,
                            )
                        } else 0f
                        val clampedNavWidth = if (navDocked) {
                            WorkspaceLayoutMath.clampNavWidth(
                                layout.navWidthDp,
                                areaWidthDp,
                                clampedCompanionWidth,
                            )
                        } else 0f

                        if (wide) {
                            Row(Modifier.fillMaxSize()) {
                                if (navDocked) {
                                    NavigationSidebar(
                                        model = model,
                                        state = state,
                                        query = query,
                                        onQueryChange = { query = it },
                                        onOpenNoteMain = { model.openNote(it) },
                                        onOpenNoteSide = { model.openNoteInPane(it, "side") },
                                        onShowWorkspace = { model.showWorkspaceHome() },
                                        onShowVideos = { model.tab(3); model.refreshVideos() },
                                        modifier = Modifier.width(clampedNavWidth.dp).fillMaxHeight(),
                                    )
                                    HorizontalResizeHandle(
                                        label = "调整目录宽度",
                                        onDeltaDp = { dx ->
                                            val next = WorkspaceLayoutMath.clampNavWidth(
                                                clampedNavWidth + dx,
                                                areaWidthDp,
                                                clampedCompanionWidth,
                                            )
                                            updateLayout(layout.copy(navWidthDp = next))
                                        },
                                        onReset = {
                                            updateLayout(layout.copy(navWidthDp = WorkspaceLayoutMath.DEFAULT_NAV_WIDTH))
                                        },
                                    )
                                }

                                Column(Modifier.weight(1f).fillMaxHeight()) {
                                    if (!hideChrome) {
                                        WorkspaceTabBar(
                                            state = state,
                                            videoTitle = video.title,
                                            hasActiveVideo = video.sourceId.isNotBlank(),
                                            onSelectHome = { model.showWorkspaceHome() },
                                            onSelectVideo = { model.tab(3) },
                                            onDockVideo = { model.dockVideo(true) },
                                            onSelectNote = { model.selectTab(it, "main") },
                                            onCloseNote = { model.closeTab(it, "main") },
                                        )
                                    }
                                    Box(Modifier.fillMaxWidth().weight(1f)) {
                                        MainAreaBody(
                                            model = model,
                                            state = state,
                                            layout = layout,
                                            wide = true,
                                            query = query,
                                            onQueryChange = { query = it },
                                            onUpdateLayout = ::updateLayout,
                                            onOpenOffline = { showOffline = true },
                                            onOpenNav = { updateLayout(layout.copy(navMode = PanelMode.DOCKED)) },
                                            externalInkCommand = externalInkCommand,
                                            externalInkNonce = externalInkNonce,
                                        )
                                    }
                                }

                                if (assistantDocked) {
                                    HorizontalResizeHandle(
                                        label = "调整右侧宽度",
                                        onDeltaDp = { dx ->
                                            val next = WorkspaceLayoutMath.clampCompanionWidth(
                                                clampedCompanionWidth - dx,
                                                areaWidthDp,
                                                clampedNavWidth,
                                            )
                                            updateLayout(layout.copy(companionWidthDp = next))
                                        },
                                        onReset = {
                                            updateLayout(layout.copy(companionWidthDp = WorkspaceLayoutMath.DEFAULT_COMPANION_WIDTH))
                                        },
                                    )
                                    CompanionDockColumn(
                                        model = model,
                                        state = state,
                                        video = video,
                                        layout = layout,
                                        areaHeightDp = areaHeightDp,
                                        onUpdateLayout = ::updateLayout,
                                        modifier = Modifier.width(clampedCompanionWidth.dp).fillMaxHeight(),
                                    )
                                }
                            }
                        } else {
                            // Medium / Compact layout
                            Column(Modifier.fillMaxSize()) {
                                if (layout.compactSplit) {
                                    // Top Pane + Draggable Vertical Divider + Bottom Pane
                                    Column(Modifier.fillMaxWidth().weight(layout.compactSplitFraction)) {
                                        if (!hideChrome && state.openTabs.size > 1) {
                                            WorkspaceTabBar(
                                                state = state,
                                                videoTitle = video.title,
                                                hasActiveVideo = video.sourceId.isNotBlank(),
                                                onSelectHome = { model.showWorkspaceHome() },
                                                onSelectVideo = { model.tab(3) },
                                                onDockVideo = { model.dockVideo(true) },
                                                onSelectNote = { model.selectTab(it, "main") },
                                                onCloseNote = { model.closeTab(it, "main") },
                                            )
                                        }
                                        Box(Modifier.fillMaxWidth().weight(1f)) {
                                            MainAreaBody(
                                                model = model,
                                                state = state,
                                                layout = layout,
                                                wide = false,
                                                query = query,
                                                onQueryChange = { query = it },
                                                onUpdateLayout = ::updateLayout,
                                                onOpenOffline = { showOffline = true },
                                                onOpenNav = { mobileDrawerOpen = true },
                                                externalInkCommand = externalInkCommand,
                                                externalInkNonce = externalInkNonce,
                                            )
                                        }
                                    }

                                    VerticalResizeHandle(
                                        label = "调整上下分屏比例",
                                        onDeltaDp = { dy ->
                                            if (areaHeightDp > 200f) {
                                                val next = WorkspaceLayoutMath.clampFraction(
                                                    layout.compactSplitFraction + dy / areaHeightDp,
                                                    0.24f,
                                                    0.78f,
                                                )
                                                updateLayout(layout.copy(compactSplitFraction = next))
                                            }
                                        },
                                        onReset = {
                                            updateLayout(layout.copy(compactSplitFraction = WorkspaceLayoutMath.DEFAULT_COMPACT_SPLIT_FRACTION))
                                        },
                                    )

                                    Column(Modifier.fillMaxWidth().weight(1f - layout.compactSplitFraction)) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .background(StudyColors.SurfaceSidebar)
                                                .padding(horizontal = 8.dp, vertical = 4.dp),
                                            horizontalArrangement = Arrangement.SpaceBetween,
                                            verticalAlignment = Alignment.CenterVertically,
                                        ) {
                                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                                TopbarTogglePill(
                                                    text = "伴学对话",
                                                    active = layout.compactBottomKind == "chat",
                                                    onClick = { updateLayout(layout.copy(compactBottomKind = "chat")) },
                                                )
                                                TopbarTogglePill(
                                                    text = "对照笔记",
                                                    active = layout.compactBottomKind == "side_note",
                                                    onClick = { updateLayout(layout.copy(compactBottomKind = "side_note")) },
                                                )
                                            }
                                            ToolbarMiniButton(
                                                text = "关闭分屏",
                                                onClick = { updateLayout(layout.copy(compactSplit = false)) },
                                            )
                                        }
                                        HorizontalDivider(color = StudyColors.Line)
                                        if (layout.compactBottomKind == "side_note") {
                                            NotePaneContent(
                                                model = model,
                                                state = state,
                                                pane = "side",
                                                layout = layout,
                                                onUpdateLayout = ::updateLayout,
                                                modifier = Modifier.fillMaxWidth().weight(1f),
                                            )
                                        } else {
                                            ChatPane(model, state, Modifier.fillMaxWidth().weight(1f))
                                        }
                                    }
                                } else {
                                    // Single-screen adaptive mode (100% compatible with LanLearningTest portrait checks)
                                    if (state.selectedTab == 3) {
                                        VideoPane(model, state, Modifier.fillMaxWidth().weight(1f))
                                    } else if (state.selectedTab == 1 && !medium) {
                                        ChatPane(model, state, Modifier.fillMaxWidth().weight(1f))
                                    } else if (state.selectedTab == 2 || (state.note == null && !state.showHome)) {
                                        Column(Modifier.fillMaxWidth().weight(1f)) {
                                            if (state.openTabs.isNotEmpty()) {
                                                WorkspaceTabBar(
                                                    state = state,
                                                    videoTitle = video.title,
                                                    hasActiveVideo = video.sourceId.isNotBlank(),
                                                    onSelectHome = { model.showWorkspaceHome() },
                                                    onSelectVideo = { model.tab(3) },
                                                    onDockVideo = { model.dockVideo(true) },
                                                    onSelectNote = { model.selectTab(it, "main") },
                                                    onCloseNote = { model.closeTab(it, "main") },
                                                )
                                            }
                                            NavigationSidebar(
                                                model = model,
                                                state = state,
                                                query = query,
                                                onQueryChange = { query = it },
                                                onOpenNoteMain = { model.openNote(it) },
                                                onOpenNoteSide = {
                                                    model.openNoteInPane(it, "side")
                                                    updateLayout(layout.copy(compactSplit = true, compactBottomKind = "side_note"))
                                                },
                                                onShowWorkspace = { model.showWorkspaceHome() },
                                                onShowVideos = { model.tab(3); model.refreshVideos() },
                                                modifier = Modifier.fillMaxSize(),
                                            )
                                        }
                                    } else {
                                        if (!hideChrome && state.openTabs.size > 1) {
                                            WorkspaceTabBar(
                                                state = state,
                                                videoTitle = video.title,
                                                hasActiveVideo = video.sourceId.isNotBlank(),
                                                onSelectHome = { model.showWorkspaceHome() },
                                                onSelectVideo = { model.tab(3) },
                                                onDockVideo = { model.dockVideo(true) },
                                                onSelectNote = { model.selectTab(it, "main") },
                                                onCloseNote = { model.closeTab(it, "main") },
                                            )
                                        }
                                        if (state.showHome || state.note == null) {
                                            WorkspaceHomePane(
                                                model = model,
                                                state = state,
                                                onOpenVideos = { model.tab(3); model.refreshVideos() },
                                                onOpenOffline = { showOffline = true },
                                                onOpenNav = { mobileDrawerOpen = true },
                                                modifier = Modifier.fillMaxWidth().weight(1f),
                                            )
                                        } else {
                                            NotePaneContent(
                                                model = model,
                                                state = state,
                                                pane = "main",
                                                layout = layout,
                                                onUpdateLayout = ::updateLayout,
                                                modifier = Modifier.fillMaxWidth().weight(1f),
                                                externalInkCommand = externalInkCommand,
                                                externalInkNonce = externalInkNonce,
                                            )
                                        }
                                    }
                                }
                            }

                            if (medium && !layout.compactSplit && state.selectedTab == 1 && layout.assistantMode != PanelMode.FLOATING) {
                                ModalBottomSheet(onDismissRequest = { model.tab(0) }) {
                                    ChatPane(model, state, Modifier.fillMaxWidth().fillMaxHeight(0.9f).imePadding())
                                }
                            }

                            // Resizable slide-over Navigation Drawer for non-wide screens
                            if (mobileDrawerOpen) {
                                val drawerWidth = WorkspaceLayoutMath.clampNavWidth(
                                    layout.navWidthDp,
                                    areaWidthDp,
                                    0f,
                                ).coerceAtMost((areaWidthDp * 0.85f).coerceAtLeast(220f))
                                Box(Modifier.fillMaxSize()) {
                                    Box(
                                        Modifier
                                            .fillMaxSize()
                                            .background(Color(0x440F172A))
                                            .clickable(
                                                interactionSource = remember { MutableInteractionSource() },
                                                indication = null,
                                                onClick = { mobileDrawerOpen = false },
                                            ),
                                    )
                                    Surface(
                                        modifier = Modifier.width(drawerWidth.dp).fillMaxHeight(),
                                        shadowElevation = 12.dp,
                                        color = StudyColors.SurfaceSidebar,
                                    ) {
                                        Row(Modifier.fillMaxSize()) {
                                            Column(Modifier.weight(1f).fillMaxHeight()) {
                                                Row(
                                                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
                                                    horizontalArrangement = Arrangement.SpaceBetween,
                                                    verticalAlignment = Alignment.CenterVertically,
                                                ) {
                                                    Text("知识库目录", style = MaterialTheme.typography.titleSmall, color = StudyColors.InkPrimary)
                                                    ToolbarMiniButton(text = "收起", onClick = { mobileDrawerOpen = false })
                                                }
                                                HorizontalDivider(color = StudyColors.Line)
                                                NavigationSidebar(
                                                    model = model,
                                                    state = state,
                                                    query = query,
                                                    onQueryChange = { query = it },
                                                    onOpenNoteMain = {
                                                        model.openNote(it)
                                                        mobileDrawerOpen = false
                                                    },
                                                    onOpenNoteSide = {
                                                        model.openNoteInPane(it, "side")
                                                        mobileDrawerOpen = false
                                                        updateLayout(layout.copy(compactSplit = true, compactBottomKind = "side_note"))
                                                    },
                                                    onShowWorkspace = {
                                                        model.showWorkspaceHome()
                                                        mobileDrawerOpen = false
                                                    },
                                                    onShowVideos = {
                                                        model.tab(3)
                                                        model.refreshVideos()
                                                        mobileDrawerOpen = false
                                                    },
                                                    modifier = Modifier.fillMaxWidth().weight(1f),
                                                )
                                            }
                                            HorizontalResizeHandle(
                                                label = "调整目录宽度",
                                                onDeltaDp = { dx ->
                                                    val next = (drawerWidth + dx).coerceIn(200f, (areaWidthDp * 0.85f).coerceAtLeast(220f))
                                                    updateLayout(layout.copy(navWidthDp = next))
                                                },
                                                onReset = { updateLayout(layout.copy(navWidthDp = WorkspaceLayoutMath.DEFAULT_NAV_WIDTH)) },
                                            )
                                        }
                                    }
                                }
                            }
                        }

                        // Floating Windows Layer (rendered according to z-order frontWindow)
                        val floatingOrder = if (layout.frontWindow == "nav") listOf("assistant", "nav") else listOf("nav", "assistant")
                        floatingOrder.forEach { windowId ->
                            if (windowId == "nav" && layout.navMode == PanelMode.FLOATING && !layout.navFloating.minimized) {
                                FloatingWindowHost(
                                    title = "知识库导航",
                                    bounds = layout.navFloating,
                                    containerWidthDp = areaWidthDp,
                                    containerHeightDp = areaHeightDp,
                                    isFront = layout.frontWindow == "nav",
                                    onFocus = { updateLayout(layout.copy(frontWindow = "nav")) },
                                    onBoundsChange = { updateLayout(layout.copy(navFloating = it)) },
                                    onDock = if (wide) {
                                        { updateLayout(layout.copy(navMode = PanelMode.DOCKED)) }
                                    } else {
                                        {
                                            updateLayout(layout.copy(navMode = PanelMode.HIDDEN))
                                            mobileDrawerOpen = true
                                        }
                                    },
                                    onMinimize = {
                                        updateLayout(layout.copy(navFloating = layout.navFloating.copy(minimized = true)))
                                    },
                                    onClose = { updateLayout(layout.copy(navMode = PanelMode.HIDDEN)) },
                                ) {
                                    NavigationSidebar(
                                        model = model,
                                        state = state,
                                        query = query,
                                        onQueryChange = { query = it },
                                        onOpenNoteMain = { model.openNote(it) },
                                        onOpenNoteSide = { model.openNoteInPane(it, "side") },
                                        onShowWorkspace = { model.showWorkspaceHome() },
                                        onShowVideos = { model.tab(3); model.refreshVideos() },
                                        modifier = Modifier.fillMaxSize(),
                                    )
                                }
                            }
                            if (windowId == "assistant" && layout.assistantMode == PanelMode.FLOATING && !layout.assistantFloating.minimized) {
                                FloatingWindowHost(
                                    title = "伴学对话",
                                    bounds = layout.assistantFloating,
                                    containerWidthDp = areaWidthDp,
                                    containerHeightDp = areaHeightDp,
                                    isFront = layout.frontWindow == "assistant",
                                    onFocus = { updateLayout(layout.copy(frontWindow = "assistant")) },
                                    onBoundsChange = { updateLayout(layout.copy(assistantFloating = it)) },
                                    onDock = if (wide) {
                                        { updateLayout(layout.copy(assistantMode = PanelMode.DOCKED)) }
                                    } else {
                                        {
                                            updateLayout(
                                                layout.copy(
                                                    assistantMode = PanelMode.HIDDEN,
                                                    compactSplit = true,
                                                    compactBottomKind = "chat",
                                                ),
                                            )
                                        }
                                    },
                                    onMinimize = {
                                        updateLayout(layout.copy(assistantFloating = layout.assistantFloating.copy(minimized = true)))
                                    },
                                    onClose = { updateLayout(layout.copy(assistantMode = PanelMode.HIDDEN)) },
                                ) {
                                    ChatPane(model, state, Modifier.fillMaxSize())
                                }
                            }
                        }

                        // Minimized floating window pills in bottom-end corner
                        Row(
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .padding(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            if (layout.navMode == PanelMode.FLOATING && layout.navFloating.minimized) {
                                MinimizedFloatingPill(
                                    label = "目录浮窗",
                                    onRestore = {
                                        updateLayout(
                                            layout.copy(
                                                navFloating = layout.navFloating.copy(minimized = false),
                                                frontWindow = "nav",
                                            ),
                                        )
                                    },
                                    onClose = { updateLayout(layout.copy(navMode = PanelMode.HIDDEN)) },
                                )
                            }
                            if (layout.assistantMode == PanelMode.FLOATING && layout.assistantFloating.minimized) {
                                MinimizedFloatingPill(
                                    label = "伴学浮窗",
                                    onRestore = {
                                        updateLayout(
                                            layout.copy(
                                                assistantFloating = layout.assistantFloating.copy(minimized = false),
                                                frontWindow = "assistant",
                                            ),
                                        )
                                    },
                                    onClose = { updateLayout(layout.copy(assistantMode = PanelMode.HIDDEN)) },
                                )
                            }
                        }
                    }

                    if (!hideChrome) {
                        WorkspaceStatusBar(state = state, layout = layout, wide = wide)
                    }
                }
            }

            if (hideChrome) {
                CollapsedChromeOverlay(
                    onExpand = { updateLayout(layout.copy(chromeCollapsed = false)) },
                    onToggleTempInk = { triggerInk("toggleTempInk") },
                    onAddPad = { triggerInk("addPad") },
                    modifier = Modifier.align(Alignment.TopEnd).padding(top = 8.dp, end = 10.dp),
                )
            }
        }
        }
    }
}

@Composable
private fun MainAreaBody(
    model: StudyViewModel,
    state: StudyUi,
    layout: WorkspaceLayoutState,
    wide: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    onUpdateLayout: (WorkspaceLayoutState) -> Unit,
    onOpenOffline: () -> Unit,
    onOpenNav: () -> Unit,
    externalInkCommand: String = "",
    externalInkNonce: Int = 0,
) {
    when {
        (state.selectedTab == 3 && !state.videoDocked) || (wide && state.questionVideo != null && !state.videoDocked) -> {
            VideoPane(model, state, Modifier.fillMaxSize(), inSideDock = false)
        }
        state.selectedTab == 2 -> {
            Column(Modifier.fillMaxSize().padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SearchInputBar(
                    query = query,
                    onQueryChange = onQueryChange,
                    onSearch = { model.search(query) },
                    onClear = { onQueryChange(""); model.search("") },
                )
                SearchNoteList(
                    notes = state.notes,
                    activePath = state.note?.optString("path").orEmpty(),
                    sidePath = state.sideNote?.optString("path").orEmpty(),
                    onOpenMain = { model.openNote(it) },
                    onOpenSide = { model.openNoteInPane(it, "side") },
                    modifier = Modifier.fillMaxWidth().weight(1f),
                )
            }
        }
        state.showHome || state.note == null -> {
            WorkspaceHomePane(
                model = model,
                state = state,
                onOpenVideos = { model.tab(3); model.refreshVideos() },
                onOpenOffline = onOpenOffline,
                onOpenNav = onOpenNav,
                modifier = Modifier.fillMaxSize(),
            )
        }
        else -> {
            NotePaneContent(
                model = model,
                state = state,
                pane = "main",
                layout = layout,
                onUpdateLayout = onUpdateLayout,
                modifier = Modifier.fillMaxSize(),
                externalInkCommand = externalInkCommand,
                externalInkNonce = externalInkNonce,
            )
        }
    }
}

@Composable
private fun CompanionDockColumn(
    model: StudyViewModel,
    state: StudyUi,
    video: VideoUi,
    layout: WorkspaceLayoutState,
    areaHeightDp: Float,
    onUpdateLayout: (WorkspaceLayoutState) -> Unit,
    modifier: Modifier = Modifier,
) {
    val hasVideoDock = state.videoDocked && video.sourceId.isNotBlank()
    val hasNoteDock = state.sideNote != null || state.sideTabs.isNotEmpty()
    val dockOpen = hasVideoDock || hasNoteDock
    var dockTab by remember(hasVideoDock, hasNoteDock) {
        mutableStateOf(if (hasVideoDock && !hasNoteDock) "video" else if (hasNoteDock) "note" else "video")
    }

    Column(modifier.background(StudyColors.SurfaceCompanion)) {
        if (dockOpen) {
            Column(Modifier.fillMaxWidth().weight(layout.dockHeightFraction)) {
                Surface(color = StudyColors.SurfaceSidebar) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (hasVideoDock) {
                            WorkspaceTabChip(
                                title = video.title.ifBlank { "课程视频" },
                                selected = dockTab == "video",
                                onClick = { dockTab = "video" },
                                trailingLabel = "⇤",
                                onTrailingClick = { model.dockVideo(false) },
                            )
                        }
                        state.sideTabs.forEach { path ->
                            WorkspaceTabChip(
                                title = path.substringAfterLast('/').removeSuffix(".md"),
                                selected = dockTab == "note" && state.sideNote?.optString("path") == path,
                                onClick = {
                                    dockTab = "note"
                                    model.selectTab(path, "side")
                                },
                                onClose = { model.closeTab(path, "side") },
                            )
                        }
                    }
                }
                HorizontalDivider(color = StudyColors.Line)
                if (dockTab == "video" && hasVideoDock) {
                    VideoPane(model, state, Modifier.fillMaxWidth().weight(1f), inSideDock = true)
                } else {
                    NotePaneContent(
                        model = model,
                        state = state,
                        pane = "side",
                        layout = layout,
                        onUpdateLayout = onUpdateLayout,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    )
                }
            }
            VerticalResizeHandle(
                label = "调整右侧学习区高度",
                onDeltaDp = { dy ->
                    if (areaHeightDp > 200f) {
                        val next = WorkspaceLayoutMath.clampFraction(layout.dockHeightFraction + dy / areaHeightDp)
                        onUpdateLayout(layout.copy(dockHeightFraction = next))
                    }
                },
                onReset = {
                    onUpdateLayout(layout.copy(dockHeightFraction = WorkspaceLayoutMath.DEFAULT_DOCK_FRACTION))
                },
            )
        }
        ChatPane(model, state, Modifier.fillMaxWidth().weight(if (dockOpen) 1f - layout.dockHeightFraction else 1f))
    }
}

@Composable
private fun ConnectionsPane(
    model: StudyViewModel,
    state: StudyUi,
    pairing: String,
    onPairingChange: (String) -> Unit,
    localAllowed: Boolean,
    onRequestLocal: () -> Unit,
    onScanQr: () -> Unit,
    onCloseConnections: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(14.dp),
            color = StudyColors.SurfacePaper,
            border = BorderStroke(1.dp, StudyColors.Line),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "把电脑上的学习带到移动端",
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                    color = StudyColors.InkPrimary,
                )
                Text(
                    "在电脑 Study Mate 中打开「平板连接」，生成二维码。扫描后，在电脑允许设备配对。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = StudyColors.InkSecondary,
                )
                if (!localAllowed && Build.VERSION.SDK_INT >= 37) {
                    Button(onClick = onRequestLocal) { Text("允许访问局域网") }
                }
                Button(enabled = !state.working, onClick = onScanQr) { Text("扫描电脑二维码") }
                OutlinedTextField(
                    value = pairing,
                    onValueChange = onPairingChange,
                    label = { Text("也可粘贴电脑的完整配对连接信息") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 5,
                )
                OutlinedButton(
                    enabled = pairing.isNotBlank() && !state.working,
                    onClick = { model.pair(pairing) },
                ) { Text("提交配对申请") }
            }
        }

        if (model.client != null) {
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = StudyColors.SurfacePaper,
                border = BorderStroke(1.dp, StudyColors.Line),
                modifier = Modifier.fillMaxWidth(),
            ) {
                var endpoint by remember { mutableStateOf("") }
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("已配对电脑设置", style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold))
                    OutlinedTextField(
                        value = endpoint,
                        onValueChange = { endpoint = it },
                        label = { Text("电脑 Wi-Fi IP:端口（自动发现不可用时）") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(
                            onClick = { model.updateEndpoint(endpoint) },
                            enabled = !state.working && endpoint.isNotBlank(),
                        ) { Text("更新地址并重连") }
                        TextButton(onClick = { model.resume(); onCloseConnections() }) { Text("重新连接电脑") }
                        TextButton(onClick = { model.disconnect(); onCloseConnections() }) {
                            Text("清除本机配对", color = StudyColors.Danger)
                        }
                    }
                }
            }
        }

        Text(
            "电脑需要保持运行。所有模型与资料由电脑提供；移动端保持只读。",
            style = MaterialTheme.typography.bodySmall,
            color = StudyColors.InkTertiary,
        )
        TextButton(onClick = model::clearRecent) { Text("清除近期内容与视频缓冲") }
        state.computers.forEach { computer ->
            Text("已发现 ${computer.name} · 首次连接请扫描电脑二维码", style = MaterialTheme.typography.bodySmall, color = StudyColors.Accent)
        }
    }
}

@Composable
private fun ChatPane(model: StudyViewModel, state: StudyUi, modifier: Modifier) {
    Column(modifier.background(StudyColors.SurfaceCompanion)) {
        state.questionVideo?.let { ref ->
            Surface(
                color = StudyColors.AccentSoft,
                border = BorderStroke(1.dp, StudyColors.AccentBorder),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "视频问题 · ${videoTime(ref.position)}（已固定）",
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelMedium,
                        color = StudyColors.Accent,
                    )
                    TextButton(onClick = model::clearVideoQuestion) { Text("移除") }
                }
            }
        }
        Surface(color = StudyColors.SurfaceTopbar) {
            Column(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "伴学对话 · " + state.model.ifBlank { "未选择模型" },
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = StudyColors.InkPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    TextButton(enabled = !state.chat.optBoolean("busy"), onClick = { model.conversation() }) {
                        Text("新对话")
                    }
                }
                HorizontalDivider(color = StudyColors.Line)
            }
        }

        var conversations by remember { mutableStateOf(false) }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = { conversations = !conversations }) {
                Text(if (conversations) "收起历史对话" else "历史对话")
            }
            Text("只读 · 资料由电脑提供", style = MaterialTheme.typography.labelSmall, color = StudyColors.InkMuted)
        }
        if (conversations) {
            val rows = state.chat.optJSONArray("conversations")
            Surface(
                color = StudyColors.BgSubtle,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                shape = RoundedCornerShape(10.dp),
                border = BorderStroke(1.dp, StudyColors.Line),
            ) {
                LazyColumn(Modifier.heightIn(max = 180.dp).padding(4.dp)) {
                    items(rows?.length() ?: 0) { index ->
                        val row = rows!!.getJSONObject(index)
                        TextButton(
                            enabled = !state.chat.optBoolean("busy"),
                            onClick = {
                                model.conversation(row.getString("id"))
                                conversations = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(row.getString("title"), modifier = Modifier.fillMaxWidth(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }

        val messages = state.chat.optJSONArray("messages")
        val source = buildString {
            if (messages == null || messages.length() == 0) {
                append("选择笔记后提问，AI 会按需读取电脑上的资料。")
            } else {
                for (index in 0 until messages.length()) {
                    val message = messages.getJSONObject(index)
                    append(if (message.optString("role") == "user") "## 你\n\n" else "## Study Mate\n\n")
                    append(message.optString("text").ifBlank { "正在思考…" })
                    append("\n\n")
                    if (message.optString("error").isNotBlank()) append("> " + message.optString("error") + "\n\n")
                    val tools = message.optJSONArray("tools")
                    if (tools != null && tools.length() > 0) {
                        append("### 资料读取过程\n\n")
                        for (toolIndex in 0 until tools.length()) {
                            val tool = tools.getJSONObject(toolIndex)
                            val label = when (tool.optString("name")) {
                                "read_note" -> "读取笔记"
                                "search_knowledge", "search_notes" -> "检索知识库"
                                "save_note", "replace_in_note", "restore_note_backup", "create_daily_task", "insert_image" -> "只读保护"
                                else -> "读取学习资料"
                            }
                            append("- $label：${tool.optString("summary")}\n")
                        }
                        append("\n")
                    }
                }
            }
        }

        ReadingView(
            source = source,
            path = "conversation/" + state.chat.optString("conversationId"),
            vaultId = state.vaultId,
            client = model.client,
            modifier = Modifier.fillMaxWidth().weight(1f),
            onNavigate = model::navigate,
            conversation = true,
        )

        (state.note ?: state.sideNote)?.let {
            Text(
                "引用资料：" + it.optString("path"),
                style = MaterialTheme.typography.labelSmall,
                color = StudyColors.Accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
            )
        }
        OutlinedTextField(
            value = state.draft,
            onValueChange = model::draft,
            placeholder = { Text("向伴学助手提问…") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            maxLines = 4,
            shape = RoundedCornerShape(12.dp),
        )
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.chat.optBoolean("busy")) {
                TextButton(onClick = { model.cancel() }, enabled = state.pendingRequest != null) { Text("停止生成") }
            } else if (state.pendingRequest != null) {
                TextButton(onClick = { model.retryPending() }, enabled = !state.working) { Text("查询或重试原问题") }
            } else {
                Button(
                    onClick = { model.send() },
                    enabled = state.connected && state.draft.isNotBlank() && !state.working,
                ) { Text("发送") }
            }
        }
    }
}
