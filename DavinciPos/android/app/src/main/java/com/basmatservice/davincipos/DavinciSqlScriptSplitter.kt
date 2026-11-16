package com.basmatservice.davincipos

/** Pure Kotlin SQL script splitter, kept independent of Android for JVM tests. */
internal object DavinciSqlScriptSplitter {
    fun split(source: String): List<String> {
            val statements = mutableListOf<String>()
            val current = StringBuilder()
            var quote: Char? = null
            var lineComment = false
            var blockComment = false
            var trigger = false
            var triggerDepth = 0
            var caseDepth = 0
            var i = 0
            while (i < source.length) {
                val c = source[i]
                val next = if (i + 1 < source.length) source[i + 1] else '\u0000'
                if (lineComment) {
                    current.append(c)
                    if (c == '\n') lineComment = false
                    i++
                    continue
                }
                if (blockComment) {
                    current.append(c)
                    if (c == '*' && next == '/') {
                        current.append(next); i += 2; blockComment = false
                    } else i++
                    continue
                }
                if (quote != null) {
                    current.append(c)
                    if (c == quote) {
                        if (next == quote) { current.append(next); i += 2; continue }
                        quote = null
                    } else if (c == '\\' && next != '\u0000') {
                        current.append(next); i += 2; continue
                    }
                    i++
                    continue
                }
                if (c == '-' && next == '-') { current.append(c).append(next); i += 2; lineComment = true; continue }
                if (c == '/' && next == '*') { current.append(c).append(next); i += 2; blockComment = true; continue }
                if (c == '\'' || c == '"' || c == '`') { quote = c; current.append(c); i++; continue }
                if (c.isLetter()) {
                    val start = i
                    while (i < source.length && (source[i].isLetterOrDigit() || source[i] == '_')) i++
                    val word = source.substring(start, i)
                    val upper = word.uppercase()
                    if (current.toString().trimStart().uppercase().startsWith("CREATE TRIGGER")) {
                        trigger = true
                        if (upper == "BEGIN") triggerDepth++
                        if (upper == "CASE") caseDepth++
                        if (upper == "END") {
                            if (caseDepth > 0) caseDepth-- else if (triggerDepth > 0) triggerDepth--
                        }
                    }
                    current.append(word)
                    continue
                }
                if (c == ';' && (!trigger || (triggerDepth == 0 && caseDepth == 0))) {
                    if (hasSqlContent(current.toString())) statements.add(current.toString().trim())
                    current.setLength(0)
                    trigger = false
                    triggerDepth = 0
                    caseDepth = 0
                } else current.append(c)
                i++
            }
            if (hasSqlContent(current.toString())) statements.add(current.toString().trim())
            return statements
        }
    private fun hasSqlContent(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            val current = value[index]
            val next = if (index + 1 < value.length) value[index + 1] else '\u0000'
            if (current.isWhitespace()) {
                index++
                continue
            }
            if (current == '-' && next == '-') {
                index += 2
                while (index < value.length && value[index] != '\n') index++
                continue
            }
            if (current == '/' && next == '*') {
                index += 2
                while (index + 1 < value.length && !(value[index] == '*' && value[index + 1] == '/')) index++
                index = (index + 2).coerceAtMost(value.length)
                continue
            }
            return true
        }
        return false
    }
}
