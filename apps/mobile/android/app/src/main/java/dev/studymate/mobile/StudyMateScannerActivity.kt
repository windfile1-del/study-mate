package dev.studymate.mobile

import android.os.Bundle
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.journeyapps.barcodescanner.camera.CameraSettings

class StudyMateScannerActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureScanner()
    }

    override fun onResume() {
        configureScanner()
        super.onResume()
    }

    private fun configureScanner() {
        val view = findViewById<DecoratedBarcodeView>(
            com.google.zxing.client.android.R.id.zxing_barcode_scanner,
        ) ?: return
        val settings = view.cameraSettings
        settings.setAutoFocusEnabled(true)
        settings.setContinuousFocusEnabled(true)
        settings.setBarcodeSceneModeEnabled(true)
        settings.setMeteringEnabled(true)
        settings.setExposureEnabled(true)
        settings.setAutoTorchEnabled(true)
        settings.focusMode = CameraSettings.FocusMode.CONTINUOUS
        view.cameraSettings = settings
        view.barcodeView.decoderFactory = DefaultDecoderFactory(
            listOf(BarcodeFormat.QR_CODE),
            mapOf(
                DecodeHintType.TRY_HARDER to true,
                DecodeHintType.CHARACTER_SET to Charsets.UTF_8.name(),
            ),
            Charsets.UTF_8.name(),
            0,
        )
        view.setStatusText("将二维码完整放入取景框，距离约 15–30 厘米")
    }
}
