package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Test

class DavinciScryptTest {
    @Test
    fun matchesRfc7914EmptyPasswordVector() {
        val actual = DavinciScrypt.derive(
            password = ByteArray(0),
            salt = ByteArray(0),
            outputLength = 64,
            cost = 16,
            blockSize = 1,
            parallelization = 1
        )
        assertEquals(
            "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
                "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
            actual.joinToString("") { "%02x".format(it) }
        )
    }
    @Test
    fun matchesNodeCompatibleDefaultParametersVector() {
        val actual = DavinciScrypt.derive(
            password = "pleaseletmein".toByteArray(Charsets.UTF_8),
            salt = "SodiumChloride".toByteArray(Charsets.UTF_8)
        )
        assertEquals(
            "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2" +
                "d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887",
            actual.joinToString("") { "%02x".format(it) }
        )
    }
    @Test
    fun matchesNodeHexTextSaltEncoding() {
        val actual = DavinciScrypt.derive(
            password = "CorrectHorseBatteryStaple!".toByteArray(Charsets.UTF_8),
            salt = "00112233445566778899aabbccddeeff".toByteArray(Charsets.UTF_8)
        )
        assertEquals(
            "fe1559ad60e4066f60b60896ee0fb5d61fe7722a3a6e095dec5022c958d79b4d" +
                "5faf1e7bc0a42f3fc74306c88bec2460f8fd052cf0ec75de912719a206285c7c",
            actual.joinToString("") { "%02x".format(it) }
        )
    }
}
