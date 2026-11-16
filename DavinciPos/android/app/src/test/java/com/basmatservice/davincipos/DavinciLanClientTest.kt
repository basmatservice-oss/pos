package com.basmatservice.davincipos

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Test

class DavinciLanClientTest {
    @Test
    fun acceptsSecureLanUrlsAtRootAndMobilePath() {
        assertNotNull(DavinciLanClient("https://192.168.1.10:3187"))
        assertNotNull(DavinciLanClient("https://pos.local:3187/mobile"))
    }

    @Test
    fun rejectsCleartextHttp() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciLanClient("http://192.168.1.10:3187/mobile")
        }
    }

    @Test
    fun rejectsUnexpectedPathsAndUrlCredentials() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciLanClient("https://192.168.1.10:3187/admin")
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciLanClient("https://user:password@192.168.1.10:3187/mobile")
        }
    }

    @Test
    fun rejectsQueryAndFragmentComponents() {
        assertThrows(IllegalArgumentException::class.java) {
            DavinciLanClient("https://192.168.1.10:3187/mobile?token=secret")
        }
        assertThrows(IllegalArgumentException::class.java) {
            DavinciLanClient("https://192.168.1.10:3187/mobile#fragment")
        }
    }
}
