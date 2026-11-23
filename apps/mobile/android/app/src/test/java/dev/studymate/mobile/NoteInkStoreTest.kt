package dev.studymate.mobile

import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class NoteInkStoreTest {
    private lateinit var root: File
    private lateinit var padsDir: File
    private lateinit var tempDir: File
    private lateinit var store: NoteInkStore

    @Before
    fun setUp() {
        root = Files.createTempDirectory("note-ink-store-test").toFile()
        padsDir = File(root, "pads")
        tempDir = File(root, "temp")
        store = NoteInkStore(padsDir, tempDir)
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun samplePadsJson(padId: String = "pad-1"): String =
        """[{"id":"$padId","title":"推导草稿","anchorType":"heading","anchorHeadingId":"h1","anchorHeadingText":"第一章","logicalHeight":420,"background":"grid","collapsed":false,"strokes":[{"id":"s1","tool":"pen","color":"#0F172A","width":4,"points":[{"x":10,"y":20},{"x":80,"y":95}]}],"createdAt":1,"updatedAt":2}]"""

    private fun sampleTempStrokesJson(strokeId: String = "tmp-1"): String =
        """[{"id":"$strokeId","tool":"pen","color":"#DC2626","width":3.5,"points":[{"x":0.2,"y":120},{"x":0.4,"y":160}]}]"""

    @Test
    fun persistentPadsSurviveContentHashChanges() {
        val v1 = NoteInkStore.contentHash("# 第一章\n原文内容")
        val v2 = NoteInkStore.contentHash("# 第一章\n修改后的笔记内容")
        assertNotEquals(v1, v2)

        store.savePadsRaw("vault-1", "math/note.md", samplePadsJson())
        val loadedV1 = store.loadData("vault-1", "math/note.md", v1)
        assertEquals(1, loadedV1.pads.size)
        assertEquals("pad-1", loadedV1.pads[0]["id"])

        val loadedV2 = store.loadData("vault-1", "math/note.md", v2)
        assertEquals(1, loadedV2.pads.size)
        assertEquals("推导草稿", loadedV2.pads[0]["title"])
    }

    @Test
    fun tempInkPersistsForSameHashAndAutoClearsWhenContentChanges() {
        val v1 = NoteInkStore.contentHash("# 标题\nA")
        val v2 = NoteInkStore.contentHash("# 标题\nA + 修改")

        store.savePadsRaw("vault-1", "demo.md", samplePadsJson())
        store.saveTempInkRaw("vault-1", "demo.md", v1, sampleTempStrokesJson())

        val same = store.loadData("vault-1", "demo.md", v1)
        assertFalse(same.tempClearedByChange)
        assertEquals(1, same.tempStrokes.size)
        assertEquals("tmp-1", same.tempStrokes[0]["id"])

        val changed = store.loadData("vault-1", "demo.md", v2)
        assertTrue(changed.tempClearedByChange)
        assertTrue(changed.tempStrokes.isEmpty())
        assertEquals(1, changed.pads.size)

        // After auto-clear deletes the temp file, subsequent loads for v2 do not re-trigger the cleared banner
        val after = store.loadData("vault-1", "demo.md", v2)
        assertFalse(after.tempClearedByChange)
        assertTrue(after.tempStrokes.isEmpty())
    }

    @Test
    fun clearAllTempInkPreservesPersistentHandwritingPads() {
        val hash = NoteInkStore.contentHash("正文")
        store.savePadsRaw("vault-1", "a.md", samplePadsJson())
        store.saveTempInkRaw("vault-1", "a.md", hash, sampleTempStrokesJson())

        store.clearAllTempInk()
        val loaded = store.loadData("vault-1", "a.md", hash)
        assertFalse(loaded.tempClearedByChange)
        assertTrue(loaded.tempStrokes.isEmpty())
        assertEquals(1, loaded.pads.size)
    }

    @Test
    fun isolatesScopesAndPaths() {
        val hash = NoteInkStore.contentHash("same")
        store.savePadsRaw("vault-a", "note.md", samplePadsJson("pad-a"))
        store.saveTempInkRaw("vault-a", "note.md", hash, sampleTempStrokesJson("tmp-a"))

        val otherVault = store.loadData("vault-b", "note.md", hash)
        assertTrue(otherVault.pads.isEmpty())
        assertTrue(otherVault.tempStrokes.isEmpty())

        val otherPath = store.loadData("vault-a", "sub/note.md", hash)
        assertTrue(otherPath.pads.isEmpty())
        assertTrue(otherPath.tempStrokes.isEmpty())
    }

    @Test
    fun rejectsExceedingMaxPadsOrPointBudget() {
        val tooManyPads = (1..41).joinToString(prefix = "[", postfix = "]") { idx ->
            """{"id":"p-$idx","title":"t","anchorType":"bottom","anchorHeadingId":"","anchorHeadingText":"","logicalHeight":420,"background":"blank","collapsed":false,"strokes":[],"createdAt":1,"updatedAt":1}"""
        }
        assertThrows(IllegalArgumentException::class.java) {
            store.savePadsRaw("vault-1", "overflow.md", tooManyPads)
        }

        val tooManyPoints = (1..2001).joinToString(prefix = "[", postfix = "]") { idx ->
            """{"x":0.1,"y":$idx}"""
        }
        val oversizeTemp = """[{"id":"big","tool":"pen","color":"#000000","width":3,"points":$tooManyPoints}]"""
        assertThrows(IllegalArgumentException::class.java) {
            store.saveTempInkRaw("vault-1", "overflow.md", NoteInkStore.contentHash("x"), oversizeTemp)
        }
    }

    @Test
    fun mergePadsCombinesLocalAndRemoteWithoutOverwritingAndPropagatesTombstones() {
        val now = 2_000_000L
        val localJson = """[
            {"id":"pad-local","title":"本地手写","anchorType":"block","anchorHeadingId":"h1","anchorHeadingText":"一","anchorBlockIndex":2,"anchorBlockText":"原文","anchorBlockOffset":1,"logicalHeight":420,"background":"grid","collapsed":false,"strokes":[],"createdAt":1000,"updatedAt":1500},
            {"id":"pad-shared","title":"旧版","anchorType":"top","anchorHeadingId":"","anchorHeadingText":"","logicalHeight":420,"background":"blank","collapsed":false,"strokes":[],"createdAt":900,"updatedAt":1200}
        ]"""
        val remoteJson = """[
            {"id":"pad-remote","title":"桌面手写","anchorType":"bottom","anchorHeadingId":"","anchorHeadingText":"","logicalHeight":460,"background":"ruled","collapsed":false,"strokes":[],"createdAt":1100,"updatedAt":1600},
            {"id":"pad-shared","title":"新版","anchorType":"top","anchorHeadingId":"","anchorHeadingText":"","logicalHeight":420,"background":"blank","collapsed":false,"strokes":[],"createdAt":900,"updatedAt":1900},
            {"id":"pad-local","title":"本地手写","anchorType":"block","anchorHeadingId":"h1","anchorHeadingText":"一","anchorBlockIndex":2,"anchorBlockText":"原文","anchorBlockOffset":1,"logicalHeight":420,"background":"grid","collapsed":false,"strokes":[],"createdAt":1000,"updatedAt":1950,"deletedAt":1950}
        ]"""

        store.savePadsRaw("vault-1", "a.md", localJson)
        store.mergePadsRaw("vault-1", "a.md", remoteJson, now = now)

        val loaded = store.loadData("vault-1", "a.md", "").pads
        assertEquals(3, loaded.size)
        val byId = loaded.associateBy { it["id"] as String }
        assertEquals("新版", byId["pad-shared"]?.get("title"))
        assertEquals("桌面手写", byId["pad-remote"]?.get("title"))
        assertEquals(1950L, (byId["pad-local"]?.get("deletedAt") as Number).toLong())

        val listed = store.listScopePadsRaw(listOf("vault-1"))
        assertEquals(1, listed.size)
        assertEquals(3, listed["a.md"]?.size)
    }
}
