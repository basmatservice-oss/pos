package com.basmatservice.davincipos

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * RFC 7914 scrypt implementation matching Node.js crypto.scrypt defaults
 * (N=16384, r=8, p=1, 64-byte output) used by the Windows server.
 */
internal object DavinciScrypt {
    fun derive(
        password: ByteArray,
        salt: ByteArray,
        outputLength: Int = 64,
        cost: Int = 16_384,
        blockSize: Int = 8,
        parallelization: Int = 1
    ): ByteArray {
        require(cost > 1 && cost and (cost - 1) == 0) { "scrypt cost must be a power of two." }
        require(blockSize > 0 && parallelization > 0 && outputLength > 0)
        val blockBytes = Math.multiplyExact(128, blockSize)
        val initial = pbkdf2(password, salt, Math.multiplyExact(blockBytes, parallelization))
        for (lane in 0 until parallelization) {
            romix(initial, lane * blockBytes, blockBytes, cost, blockSize)
        }
        return pbkdf2(password, initial, outputLength)
    }

    private fun pbkdf2(password: ByteArray, salt: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val output = ByteArray(length)
        val input = ByteArray(salt.size + 4)
        System.arraycopy(salt, 0, input, 0, salt.size)
        var offset = 0
        var block = 1
        while (offset < length) {
            input[input.size - 4] = (block ushr 24).toByte()
            input[input.size - 3] = (block ushr 16).toByte()
            input[input.size - 2] = (block ushr 8).toByte()
            input[input.size - 1] = block.toByte()
            val value = mac.doFinal(input)
            val count = minOf(value.size, length - offset)
            System.arraycopy(value, 0, output, offset, count)
            offset += count
            block++
        }
        return output
    }

    private fun romix(buffer: ByteArray, offset: Int, blockBytes: Int, cost: Int, r: Int) {
        val memory = ByteArray(Math.multiplyExact(cost, blockBytes))
        val x = ByteArray(blockBytes)
        System.arraycopy(buffer, offset, x, 0, blockBytes)
        for (i in 0 until cost) {
            System.arraycopy(x, 0, memory, i * blockBytes, blockBytes)
            blockMix(x, r)
        }
        for (i in 0 until cost) {
            val integerifyOffset = (2 * r - 1) * 64
            val j = (x[integerifyOffset].toInt() and 0xff) or
                ((x[integerifyOffset + 1].toInt() and 0xff) shl 8) or
                ((x[integerifyOffset + 2].toInt() and 0xff) shl 16) or
                ((x[integerifyOffset + 3].toInt() and 0xff) shl 24)
            val selected = (j and (cost - 1)) * blockBytes
            for (k in x.indices) x[k] = (x[k].toInt() xor memory[selected + k].toInt()).toByte()
            blockMix(x, r)
        }
        System.arraycopy(x, 0, buffer, offset, blockBytes)
        memory.fill(0)
        x.fill(0)
    }

    private fun blockMix(block: ByteArray, r: Int) {
        val x = IntArray(16)
        val y = IntArray(32 * r)
        val words = 32 * r
        for (i in 0 until 16) x[i] = readInt(block, (2 * r - 1) * 64 + i * 4)
        for (i in 0 until 2 * r) {
            val base = i * 64
            for (word in 0 until 16) x[word] = x[word] xor readInt(block, base + word * 4)
            salsa208(x)
            for (word in 0 until 16) y[i * 16 + word] = x[word]
        }
        var targetWord = 0
        for (i in 0 until r) {
            for (word in 0 until 16) writeInt(block, (targetWord + word) * 4, y[(2 * i) * 16 + word])
            targetWord += 16
        }
        for (i in 0 until r) {
            for (word in 0 until 16) writeInt(block, (targetWord + word) * 4, y[(2 * i + 1) * 16 + word])
            targetWord += 16
        }
        x.fill(0)
        y.fill(0)
        check(targetWord == words)
    }

    private fun salsa208(state: IntArray) {
        val original = state.copyOf()
        repeat(4) {
            // Column rounds
            state[4] = state[4] xor rotl(state[0] + state[12], 7)
            state[8] = state[8] xor rotl(state[4] + state[0], 9)
            state[12] = state[12] xor rotl(state[8] + state[4], 13)
            state[0] = state[0] xor rotl(state[12] + state[8], 18)
            state[9] = state[9] xor rotl(state[5] + state[1], 7)
            state[13] = state[13] xor rotl(state[9] + state[5], 9)
            state[1] = state[1] xor rotl(state[13] + state[9], 13)
            state[5] = state[5] xor rotl(state[1] + state[13], 18)
            state[14] = state[14] xor rotl(state[10] + state[6], 7)
            state[2] = state[2] xor rotl(state[14] + state[10], 9)
            state[6] = state[6] xor rotl(state[2] + state[14], 13)
            state[10] = state[10] xor rotl(state[6] + state[2], 18)
            state[3] = state[3] xor rotl(state[15] + state[11], 7)
            state[7] = state[7] xor rotl(state[3] + state[15], 9)
            state[11] = state[11] xor rotl(state[7] + state[3], 13)
            state[15] = state[15] xor rotl(state[11] + state[7], 18)
            // Row rounds
            state[1] = state[1] xor rotl(state[0] + state[3], 7)
            state[2] = state[2] xor rotl(state[1] + state[0], 9)
            state[3] = state[3] xor rotl(state[2] + state[1], 13)
            state[0] = state[0] xor rotl(state[3] + state[2], 18)
            state[6] = state[6] xor rotl(state[5] + state[4], 7)
            state[7] = state[7] xor rotl(state[6] + state[5], 9)
            state[4] = state[4] xor rotl(state[7] + state[6], 13)
            state[5] = state[5] xor rotl(state[4] + state[7], 18)
            state[11] = state[11] xor rotl(state[10] + state[9], 7)
            state[8] = state[8] xor rotl(state[11] + state[10], 9)
            state[9] = state[9] xor rotl(state[8] + state[11], 13)
            state[10] = state[10] xor rotl(state[9] + state[8], 18)
            state[12] = state[12] xor rotl(state[15] + state[14], 7)
            state[13] = state[13] xor rotl(state[12] + state[15], 9)
            state[14] = state[14] xor rotl(state[13] + state[12], 13)
            state[15] = state[15] xor rotl(state[14] + state[13], 18)
        }
        for (i in 0 until 16) state[i] += original[i]
        original.fill(0)
    }

    private fun readInt(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            (bytes[offset + 3].toInt() shl 24)

    private fun writeInt(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = value.toByte()
        bytes[offset + 1] = (value ushr 8).toByte()
        bytes[offset + 2] = (value ushr 16).toByte()
        bytes[offset + 3] = (value ushr 24).toByte()
    }

    private fun rotl(value: Int, shift: Int): Int = (value shl shift) or (value ushr (32 - shift))
}
