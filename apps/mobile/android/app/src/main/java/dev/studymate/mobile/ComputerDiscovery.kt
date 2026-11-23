package dev.studymate.mobile

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build

data class DiscoveredComputer(val id: String, val name: String, val addresses: List<String>, val port: Int)
class ComputerDiscovery(context: Context, private val found: (DiscoveredComputer) -> Unit) {
    private val manager = context.getSystemService(NsdManager::class.java)
    private var listener: NsdManager.DiscoveryListener? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val queue = java.util.ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var generation = 0
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving || queue.isEmpty() || listener == null) return
        val service = queue.removeFirst(); resolving = true; val current = generation
        fun finish() { handler.post { if (current == generation) { resolving = false; resolveNext() } } }
        runCatching { manager.resolveService(service, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, code: Int) { finish() }
            override fun onServiceResolved(info: NsdServiceInfo) {
                try {
                    if (current != generation) return
                    val id = info.attributes["id"]?.toString(Charsets.UTF_8) ?: return
                    if (info.attributes["version"]?.toString(Charsets.UTF_8) != "1") return
                    val advertised = info.attributes["address"]?.toString(Charsets.UTF_8)
                    val addresses = (if (advertised != null) listOf(advertised) else (if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)).mapNotNull { it.hostAddress })
                        .filter { it.startsWith("10.") || it.startsWith("192.168.") || it.matches(Regex("172\\.(1[6-9]|2[0-9]|3[01])\\..*")) }
                    if (addresses.isNotEmpty()) found(DiscoveredComputer(id, info.serviceName, addresses, info.port))
                } finally { finish() }
            }
        }) }.onFailure { finish() }
    }
    @Suppress("DEPRECATION")
    fun start() {
        if (listener != null) return
        val next = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { stop() }
            override fun onStopDiscoveryFailed(type: String, code: Int) { listener = null }
            override fun onServiceLost(service: NsdServiceInfo) {}
            override fun onServiceFound(service: NsdServiceInfo) {
                if (!service.serviceType.startsWith("_studymate._tcp")) return
                handler.post { queue.add(service); resolveNext() }
            }
        }
        listener = next
        runCatching { manager.discoverServices("_studymate._tcp.", NsdManager.PROTOCOL_DNS_SD, next) }.onFailure { listener = null }
    }
    fun stop() { val current = listener ?: return; listener = null; generation++; handler.post { queue.clear(); resolving = false }; runCatching { manager.stopServiceDiscovery(current) } }
}
