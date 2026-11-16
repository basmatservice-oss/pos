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
}
