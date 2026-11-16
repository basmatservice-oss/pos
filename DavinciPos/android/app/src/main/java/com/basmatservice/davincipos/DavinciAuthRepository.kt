package com.basmatservice.davincipos

import android.content.ContentValues
import android.os.Looper
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.Base64
import java.util.UUID

data class DavinciAuthenticatedUser(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
    val permissions: List<String>
)

data class DavinciLoginSession(
    val token: String,
    val expiresAt: String,
    val user: DavinciAuthenticatedUser
)

/**
 * Local authentication compatible with security.js: Node scrypt(N=16384,r=8,p=1,
 * dkLen=64), SHA-256 session-token digests, 12-hour sessions and the same role
 * permission records. Password derivation is intentionally performed off the UI thread.
 */
class DavinciAuthRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)
    private val random = SecureRandom()

    fun createUser(
        username: String,
        password: CharArray,
        displayName: String,
        role: String = "cashier",
        actorUserId: String? = null
    ): String {
        require(Looper.myLooper() != Looper.getMainLooper()) { "Password derivation must run on a background thread." }
        val normalized = username.trim().lowercase()
        require(normalized.matches(Regex("^[a-zA-Z0-9._-]{3,48}$"))) { "Invalid username." }
        require(password.size in 12..256) { "Password must contain at least 12 characters." }
        val cleanDisplayName = requiredText(displayName, "display name", 160)
        require(role in ROLES) { "Invalid role." }
        if (role == "owner") {
            require(actorUserId != null && getUserRole(actorUserId) == "owner") {
                "Only an authenticated owner can create another owner account."
            }
        }
        val salt = ByteArray(16).also(random::nextBytes)
        val derived = try {
            DavinciScrypt.derive(String(password).toByteArray(Charsets.UTF_8), salt)
        } finally {
            password.fill('\u0000')
        }
        val passwordHash = hex(salt) + ":" + hex(derived)
        derived.fill(0)
        val id = UUID.randomUUID().toString()
        val now = Instant.now().toString()
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.insertOrThrow("users", null, ContentValues().apply {
                put("id", id)
                put("username", normalized)
                put("password_hash", passwordHash)
                put("display_name", cleanDisplayName)
                put("role", role)
                put("is_active", 1)
                put("created_at", now)
                put("updated_at", now)
            })
            db.insertOrThrow("audit_logs", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                if (actorUserId == null) putNull("user_id") else put("user_id", actorUserId)
                put("action", "user.create")
                put("entity_type", "user")
                put("entity_id", id)
                put("details", org.json.JSONObject().put("username", normalized).put("role", role).toString())
                put("created_at", now)
            })
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return id
    }

    fun login(username: String, password: CharArray): DavinciLoginSession? {
        require(Looper.myLooper() != Looper.getMainLooper()) { "Password verification must run on a background thread." }
        val normalized = username.trim().lowercase()
        val row = helper.readableDatabase.rawQuery(
            "SELECT id,username,password_hash,display_name,role FROM users WHERE username=? AND is_active=1",
            arrayOf(normalized)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else arrayOf(
                cursor.getString(0), cursor.getString(1), cursor.getString(2),
                cursor.getString(3), cursor.getString(4)
            )
        } ?: run { password.fill('\u0000'); return null }

        val stored = row[2].split(":")
        if (stored.size != 2) { password.fill('\u0000'); return null }
        val salt = unhex(stored[0])
        val expected = unhex(stored[1])
        val actual = try {
            DavinciScrypt.derive(String(password).toByteArray(Charsets.UTF_8), salt)
        } finally {
            password.fill('\u0000')
        }
        val valid = MessageDigest.isEqual(expected, actual)
        actual.fill(0)
        if (!valid) return null

        val tokenBytes = ByteArray(32).also(random::nextBytes)
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(tokenBytes)
        tokenBytes.fill(0)
        val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        val now = Instant.now()
        val expires = now.plus(12, ChronoUnit.HOURS)
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.delete("user_sessions", "expires_at<=?", arrayOf(now.toString()))
            db.insertOrThrow("user_sessions", null, ContentValues().apply {
                put("id", UUID.randomUUID().toString())
                put("user_id", row[0])
                put("token_hash", hex(digest))
                put("expires_at", expires.toString())
                put("created_at", now.toString())
            })
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return DavinciLoginSession(token, expires.toString(), DavinciAuthenticatedUser(
            row[0], row[1], row[3], row[4], permissionsForRole(row[4])
        ))
    }

    fun authenticate(token: String?): DavinciAuthenticatedUser? {
        if (token.isNullOrBlank()) return null
        val digest = hex(MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)))
        val now = Instant.now().toString()
        return helper.readableDatabase.rawQuery(
            """SELECT u.id,u.username,u.display_name,u.role
               FROM user_sessions s JOIN users u ON u.id=s.user_id
               WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1""".trimIndent(),
            arrayOf(digest, now)
        ).use { cursor ->
            if (!cursor.moveToFirst()) null else {
                val role = cursor.getString(3)
                DavinciAuthenticatedUser(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2),
                    role, permissionsForRole(role)
                )
            }
        }
    }

    fun logout(token: String): Int {
        val digest = hex(MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8)))
        return helper.writableDatabase.delete("user_sessions", "token_hash=?", arrayOf(digest))
    }

    private fun permissionsForRole(role: String): List<String> =
        helper.readableDatabase.rawQuery(
            "SELECT permission FROM role_permissions WHERE role_name=? ORDER BY permission",
            arrayOf(role)
        ).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(0)) }
        }

    private fun getUserRole(userId: String): String? =
        helper.readableDatabase.rawQuery("SELECT role FROM users WHERE id=?", arrayOf(userId))
            .use { if (it.moveToFirst()) it.getString(0) else null }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private fun unhex(value: String): ByteArray {
        require(value.length % 2 == 0 && value.matches(Regex("^[0-9a-fA-F]*$"))) { "Invalid password hash." }
        return ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    companion object {
        private val ROLES = setOf("owner", "admin", "manager", "cashier", "accountant", "sales")
    }
}
