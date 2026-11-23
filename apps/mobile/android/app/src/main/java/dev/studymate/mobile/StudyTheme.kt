package dev.studymate.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object StudyColors {
    val BgApp = Color(0xFFF3F5F8)
    val BgSubtle = Color(0xFFF1F5F9)
    val SurfacePaper = Color(0xFFFFFFFF)
    val SurfaceSidebar = Color(0xFFF6F8FB)
    val SurfaceTopbar = Color(0xFFFBFCFE)
    val SurfaceCompanion = Color(0xFFFCFDFE)
    val InkPrimary = Color(0xFF0F172A)
    val InkSecondary = Color(0xFF334155)
    val InkTertiary = Color(0xFF64748B)
    val InkMuted = Color(0xFF94A3B8)
    val Accent = Color(0xFF0F766E)
    val AccentHover = Color(0xFF115E59)
    val AccentSoft = Color(0x160F766E)
    val AccentBorder = Color(0x380F766E)
    val Line = Color(0x140F172A)
    val LineStrong = Color(0x220F172A)
    val WarmBg = Color(0xFFFEF7ED)
    val WarmInk = Color(0xFFB45309)
    val Danger = Color(0xFFDC2626)
    val Connected = Color(0xFF10B981)
}

private val StudyLightColorScheme = lightColorScheme(
    primary = StudyColors.Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD9F2EC),
    onPrimaryContainer = Color(0xFF0A4A44),
    secondary = Color(0xFF334155),
    secondaryContainer = Color(0xFFE2F1E8),
    onSecondaryContainer = StudyColors.InkPrimary,
    background = StudyColors.BgApp,
    onBackground = StudyColors.InkPrimary,
    surface = StudyColors.SurfacePaper,
    onSurface = StudyColors.InkPrimary,
    surfaceVariant = StudyColors.BgSubtle,
    onSurfaceVariant = StudyColors.InkSecondary,
    outline = StudyColors.LineStrong,
    outlineVariant = StudyColors.Line,
    error = StudyColors.Danger,
)

@Composable
fun StudyMateTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = StudyLightColorScheme, content = content)
}
