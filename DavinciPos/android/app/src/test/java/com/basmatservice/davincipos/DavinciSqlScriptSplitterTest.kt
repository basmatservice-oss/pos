package com.basmatservice.davincipos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DavinciSqlScriptSplitterTest {
    @Test
    fun splitsRegularStatementsAndIgnoresSemicolonsInsideStrings() {
        val sql = """
            CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);
            INSERT INTO sample(value) VALUES('one; two');
            SELECT "semi;colon" FROM sample;
        """.trimIndent()

        val statements = DavinciSqlScriptSplitter.split(sql)

        assertEquals(3, statements.size)
        assertTrue(statements[1].contains("'one; two'"))
        assertTrue(statements[2].contains("\"semi;colon\""))
    }

    @Test
    fun keepsTriggerBodyTogetherIncludingCaseEnd() {
        val sql = """
            CREATE TRIGGER guard_update
            BEFORE UPDATE ON ledger
            BEGIN
              SELECT CASE WHEN NEW.amount < 0
                THEN RAISE(ABORT, 'negative; amount')
              END;
              UPDATE audit SET changed = 1;
            END;
            SELECT 1;
        """.trimIndent()

        val statements = DavinciSqlScriptSplitter.split(sql)

        assertEquals(2, statements.size)
        assertTrue(statements[0].startsWith("CREATE TRIGGER"))
        assertTrue(statements[0].contains("UPDATE audit SET changed = 1;"))
        assertEquals("SELECT 1", statements[1])
    }

    @Test
    fun preservesCommentsWithoutCreatingEmptyStatements() {
        val sql = """
            -- heading; comment
            CREATE TABLE a(id INTEGER); /* inline; comment */
            SELECT 1; -- trailing; comment
        """.trimIndent()

        val statements = DavinciSqlScriptSplitter.split(sql)

        assertEquals(2, statements.size)
        assertTrue(statements[0].contains("-- heading; comment"))
        assertTrue(statements[1].contains("/* inline; comment */"))
    }
}
