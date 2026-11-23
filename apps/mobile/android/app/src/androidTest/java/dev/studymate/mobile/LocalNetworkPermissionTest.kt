package dev.studymate.mobile

import android.content.pm.PackageManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket

@RunWith(AndroidJUnit4::class)
class LocalNetworkPermissionTest {
    @Test fun deniedPermissionActuallyBlocksLanSockets() {
        assumeTrue(Build.VERSION.SDK_INT >= 37)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals(PackageManager.PERMISSION_DENIED, context.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK"))
        val args = InstrumentationRegistry.getArguments()
        val failure = runCatching { Socket().use { it.connect(InetSocketAddress(requireNotNull(args.getString("address")), requireNotNull(args.getString("port")).toInt()), 5000) } }.exceptionOrNull()
        assertNotNull("缺少局域网权限时连接应被系统拒绝", failure)
        assertTrue("需要权限拒绝证据，不能用超时或网络不通替代：$failure", failure.toString().contains(Regex("EACCES|EPERM|Permission denied|Operation not permitted", RegexOption.IGNORE_CASE)))
    }
}
