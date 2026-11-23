package dev.studymate.mobile

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import android.util.Base64
import java.net.InetAddress
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import java.util.concurrent.TimeUnit

class RemoteApiException(val code: String, message: String) : java.io.IOException(message)

class LanClient(val connection: JSONObject, private val store: SecureStore) {
    companion object {
        private val cleanup = java.util.concurrent.Executors.newSingleThreadExecutor { task -> Thread(task, "StudyMate-network-cleanup").apply { isDaemon = true } }
    }
    val hostname: String = connection.optString("hostname").ifBlank {
        connection.getString("serverId") + ".studymate.local"
    }
    private val refreshLock = Any()
    private val certificate: X509Certificate? = connection.optString("certificate").takeIf { it.isNotBlank() }
        ?.let {
            CertificateFactory.getInstance("X.509").generateCertificate(
                Base64.decode(it, Base64.DEFAULT).inputStream(),
            ) as X509Certificate
        }
    private val client: OkHttpClient
    init {
        require(connection.getInt("version") == 1) { "电脑连接协议版本不兼容，请更新应用。" }
        require(hostname == connection.getString("serverId") + ".studymate.local") { "电脑身份无效。" }
        val pin = connection.getString("pin")
        require(pin.length == 44) { "电脑证书指纹格式无效。" }
        certificate?.let {
            it.checkValidity()
            val actual = Base64.encodeToString(
                MessageDigest.getInstance("SHA-256").digest(it.publicKey.encoded),
                Base64.NO_WRAP,
            )
            require(actual == pin) { "电脑证书指纹不匹配。" }
        }
        val trust: X509TrustManager = certificate?.let { saved ->
            val trustStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
                load(null)
                setCertificateEntry("computer", saved)
            }
            val managers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                .apply { init(trustStore) }
                .trustManagers
            managers.single() as X509TrustManager
        } ?: object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                throw java.security.cert.CertificateException("Client certificates are not supported")
            }
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw java.security.cert.CertificateException("Missing server certificate")
                leaf.checkValidity()
                val actual = Base64.encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded),
                    Base64.NO_WRAP,
                )
                if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) {
                    throw java.security.cert.CertificateException("Computer certificate pin mismatch")
                }
            }
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        val connectivity = store.context.getSystemService(android.net.ConnectivityManager::class.java)
        val wifi = connectivity.allNetworks.firstOrNull { network ->
            connectivity.getNetworkCapabilities(network)?.let { it.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) && it.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_VPN) } == true
        }
        client = OkHttpClient.Builder().apply { wifi?.let { socketFactory(it.socketFactory) } }.proxy(java.net.Proxy.NO_PROXY).sslSocketFactory(tls.socketFactory, trust)
            .certificatePinner(CertificatePinner.Builder().add(hostname, "sha256/$pin").build())
            .dns { host -> if (host == hostname) {
                val addresses = connection.getJSONArray("addresses")
                (0 until addresses.length()).map { addresses.getString(it) }.onEach {
                    require(it.matches(Regex("10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2[0-9]|3[01])\\.\\d+\\.\\d+|127\\.0\\.0\\.1"))) { "连接地址不属于局域网。" }
                }.map { InetAddress.getByName(it) }
            } else throw java.net.UnknownHostException("未授权的连接目标") }
            .connectTimeout(6, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).pingInterval(10, TimeUnit.SECONDS).build()
    }
    fun url(path: String) = "https://$hostname:${connection.getInt("port")}" + path
    fun updateAddress(computer: DiscoveredComputer) {
        if (computer.id != connection.getString("serverId")) return
        val known = connection.getJSONArray("addresses")
        val candidates = ((0 until known.length()).map { known.getString(it) }.take(2) + computer.addresses.take(2)).distinct()
        connection.put("addresses", org.json.JSONArray(candidates)).put("port", computer.port)
        cleanup.execute { client.connectionPool.evictAll() }
        if (connection.has("refreshToken")) store.save(connection.toString())
    }
    private fun request(path: String, body: JSONObject?, authorized: Boolean): Request = Request.Builder().url(url(path)).apply {
        if (authorized) header("Authorization", "Bearer " + connection.optString("accessToken"))
        if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
    }.build()
    fun json(path: String, body: JSONObject? = null, authorized: Boolean = true): JSONObject {
        execute(path, body, authorized).use { response ->
            val text = response.body?.string().orEmpty()
            val value = runCatching { JSONObject(text) }.getOrElse { throw java.io.IOException("电脑返回了无法读取的内容。") }
            if (!response.isSuccessful) throw RemoteApiException(value.optJSONObject("error")?.optString("code") ?: "HTTP_${response.code}", value.optJSONObject("error")?.optString("message") ?: "电脑请求失败：${response.code}")
            return value
        }
    }
    fun execute(path: String, body: JSONObject? = null, authorized: Boolean = true): Response {
        val access = connection.optString("accessToken")
        val response = client.newCall(request(path, body, authorized)).execute()
        if (response.code != 401 || !authorized || !connection.has("refreshToken")) return response
        response.close()
        refresh(access)
        return client.newCall(request(path, body, true)).execute()
    }
    private fun refresh(access: String) {
        synchronized(refreshLock) {
            if (access == connection.optString("accessToken")) {
                val fresh = json("/v1/auth/refresh", JSONObject().put("refreshToken", connection.getString("refreshToken")), false)
                for (name in listOf("accessToken", "refreshToken", "expiresAt", "deviceId")) connection.put(name, fresh.get(name))
                store.save(connection.toString())
            }
        }
    }
    fun acceptCredentials(credentials: JSONObject) {
        connection.remove("secret")
        for (name in listOf("deviceId", "accessToken", "refreshToken", "expiresAt")) connection.put(name, credentials.get(name))
        store.save(connection.toString())
    }
    fun events(listener: WebSocketListener): WebSocket {
        json("/v1/session")
        return client.newWebSocket(request("/v1/events", null, true), listener)
    }
    fun mediaDataSource(): androidx.media3.datasource.HttpDataSource.Factory {
        val authorized = client.newBuilder().followRedirects(false).followSslRedirects(false).addInterceptor { chain ->
            val url = chain.request().url
            if (url.scheme != "https" || url.host != hostname || url.port != connection.getInt("port")) throw java.io.IOException("未授权的媒体目标")
            val token = connection.optString("accessToken")
            val response = chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer $token").build())
            if (response.code == 401 && connection.has("refreshToken")) {
                response.close(); refresh(token)
                chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer " + connection.optString("accessToken")).build())
            } else response
        }.build()
        return androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(authorized)
    }
    @androidx.media3.common.util.UnstableApi
    fun mediaSource(descriptor: JSONObject): androidx.media3.exoplayer.source.MediaSource {
        val tracks = descriptor.getJSONArray("tracks")
        require(tracks.length() in 1..2) { "课程媒体描述无效。" }
        val cached = androidx.media3.datasource.cache.CacheDataSource.Factory().setCache(VideoBuffer.get(store.context)).setUpstreamDataSourceFactory(mediaDataSource()).setFlags(androidx.media3.datasource.cache.CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        val factory = androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(cached)
        val sources = (0 until tracks.length()).map { index ->
            val track = tracks.getJSONObject(index)
            val path = track.getString("path")
            require(path.matches(Regex("/v1/media/[a-f0-9]{24}(/tracks/[a-f0-9-]{36})?"))) { "课程媒体路径无效。" }
            val key = connection.getString("serverId") + ":" + connection.optString("deviceId") + ":" + connection.optString("vaultId") + ":" + descriptor.getString("sourceId") + ":" + track.getString("kind") + ":" + track.optString("cacheKey", path)
            factory.createMediaSource(androidx.media3.common.MediaItem.Builder().setUri(url(path)).setCustomCacheKey(key).setMimeType(track.getString("mime")).build())
        }
        return if (sources.size == 1) sources[0] else androidx.media3.exoplayer.source.MergingMediaSource(true, *sources.toTypedArray())
    }
    fun close() { cleanup.execute { client.dispatcher.cancelAll(); client.connectionPool.evictAll() } }
}
