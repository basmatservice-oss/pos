package com.basmatservice.davincipos

import android.content.ContentValues
import java.time.Instant
import java.util.UUID

data class DavinciCustomer(
    val id: String,
    val name: String,
    val phone: String?,
    val email: String?
)

data class DavinciSupplier(
    val id: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val address: String?
)

/** Typed customer/supplier access for the local Android SQLite store. */
class DavinciPeopleRepository(context: android.content.Context) {
    private val helper = DavinciDatabase.get(context.applicationContext)

    fun listCustomers(): List<DavinciCustomer> =
        helper.readableDatabase.rawQuery(
            "SELECT id,name,phone,email FROM customers ORDER BY name COLLATE NOCASE,id",
            null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciCustomer(
                        id = cursor.getString(0),
                        name = cursor.getString(1),
                        phone = cursor.nullableString(2),
                        email = cursor.nullableString(3)
                    )
                )
            }
        }

    fun createCustomer(
        name: String,
        phone: String? = null,
        email: String? = null,
        id: String = UUID.randomUUID().toString()
    ): String {
        val now = Instant.now().toString()
        val values = ContentValues().apply {
            put("id", id)
            put("name", requiredText(name, "customer name", 160))
            putOptional("phone", phone, 40)
            putOptional("email", email, 254)
            put("created_at", now)
            put("updated_at", now)
        }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.insertOrThrow("customers", null, values)
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    fun listSuppliers(): List<DavinciSupplier> =
        helper.readableDatabase.rawQuery(
            "SELECT id,name,phone,email,address FROM suppliers ORDER BY name COLLATE NOCASE,id",
            null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) add(
                    DavinciSupplier(
                        id = cursor.getString(0),
                        name = cursor.getString(1),
                        phone = cursor.nullableString(2),
                        email = cursor.nullableString(3),
                        address = cursor.nullableString(4)
                    )
                )
            }
        }

    fun createSupplier(
        name: String,
        phone: String? = null,
        email: String? = null,
        address: String? = null,
        id: String = UUID.randomUUID().toString()
    ): String {
        val now = Instant.now().toString()
        val values = ContentValues().apply {
            put("id", id)
            put("name", requiredText(name, "supplier name", 160))
            putOptional("phone", phone, 40)
            putOptional("email", email, 254)
            putOptional("address", address, 500)
            put("created_at", now)
            put("updated_at", now)
        }
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            db.insertOrThrow("suppliers", null, values)
            db.setTransactionSuccessful()
            return id
        } finally {
            db.endTransaction()
        }
    }

    private fun ContentValues.putOptional(key: String, value: String?, maxLength: Int) {
        val clean = value?.trim()?.takeIf { it.isNotEmpty() }
        if (clean == null) putNull(key)
        else {
            require(clean.length <= maxLength) { "Invalid $key." }
            put(key, clean)
        }
    }

    private fun requiredText(value: String, label: String, maxLength: Int): String {
        val clean = value.trim()
        require(clean.isNotEmpty() && clean.length <= maxLength) { "Invalid $label." }
        return clean
    }

    private fun android.database.Cursor.nullableString(index: Int): String? =
        if (isNull(index)) null else getString(index)
}
