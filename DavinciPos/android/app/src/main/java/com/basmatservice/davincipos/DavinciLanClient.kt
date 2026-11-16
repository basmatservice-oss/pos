package com.basmatservice.davincipos

import android.os.Looper
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection

data class DavinciLanResponse(
    val statusCode: Int,
    val body: String
) {
    val isSuccessful: Boolean get() = statusCode in 200..299
}

class DavinciLanException(
    message: String,
    val statusCode: Int? = null
) : Exception(message)

/**
 * HTTPS client for the existing DavinciPos Node/Express server on a local LAN.
 *
 * It deliberately uses Android's normal certificate validation. Never install a
 * trust-all manager here: private-LAN traffic still carries credentials and sales.
 * Call methods from an IO/background thread, not from the Android main thread.
 */
class DavinciLanClient(serverMobileUrl: String) {
    private val apiBaseUrl: String

    init {
        val normalized = serverMobileUrl.trim().removeSuffix("/")
        val uri = try { URI(normalized) }
        catch (_: Exception) { throw IllegalArgumentException("Invalid server URL.") }

        require(uri.scheme.equals("https", ignoreCase = true)) {
            "The LAN server must use HTTPS."
        }
        require(!uri.host.isNullOrBlank()) { "Server host is required." }
        require(uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "Server URL must not contain credentials, query parameters or fragments."
        }
        require(uri.path.isNullOrEmpty() || uri.path == "/" || uri.path == "/mobile") {
            "Server URL must point to the server root or /mobile."
        }
        val authority = buildString {
            append(uri.host)
            if (uri.port != -1) append(":").append(uri.port)
        }
        apiBaseUrl = "https://$authority"
    }

    fun checkHealth(): DavinciLanResponse = request("GET", "/api/health")

    fun login(username: String, password: String): DavinciLanResponse {
        require(username.isNotBlank() && password.isNotEmpty()) { "Username and password are required." }
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
        return request("POST", "/api/auth/login", body)
    }

    fun request(
        method: String,
        apiPath: String,
        body: JSONObject? = null,
        bearerToken: String? = null,
        idempotencyKey: String? = null
    ): DavinciLanResponse {
        check(Looper.myLooper() != Looper.getMainLooper()) {
            "LAN requests must run on a background thread."
        }
        require(method in setOf("GET", "POST", "PUT", "PATCH", "DELETE")) {
            "Unsupported HTTP method."
        }
        require(apiPath.startsWith("/api/") && !apiPath.startsWith("//") &&
            !apiPath.contains("..") && !apiPath.contains('\\')) {
            "Only valid /api endpoints are allowed."
        }

        val connection = (URL(apiBaseUrl + apiPath).openConnection() as? HttpsURLConnection)
            ?: throw DavinciLanException("HTTPS connection could not be created.")
        try {
            connection.requestMethod = method
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.useCaches = false
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/json")
            bearerToken?.takeIf { it.isNotBlank() }?.let {
                connection.setRequestProperty("Authorization", "Bearer $it")
            }
            idempotencyKey?.takeIf { it.isNotBlank() }?.let {
                connection.setRequestProperty("Idempotency-Key", it)
            }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { output ->
                    output.write(body.toString().toByteArray(Charsets.UTF_8))
                }
            }

            val status = connection.responseCode
            val stream = if (status in 200..399) connection.inputStream else connection.errorStream
            val responseBody = stream?.use { it.readUtf8() }.orEmpty()
            return DavinciLanResponse(status, responseBody)
        } catch (error: DavinciLanException) {
            throw error
        } catch (error: Exception) {
            throw DavinciLanException(
                "Cannot reach DavinciPos server. Check the computer IP, LAN, server port and trusted HTTPS certificate: ${error.message}"
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun InputStream.readUtf8(): String =
        BufferedReader(InputStreamReader(this, Charsets.UTF_8)).use { it.readText() }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val READ_TIMEOUT_MS = 15_000
    }
}
