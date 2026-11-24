import { describe, expect, it } from "vitest";
import { stripUploadedImagesPrefix } from "./upload-prefix.js";

describe("stripUploadedImagesPrefix", () => {
	it("removes the injected image-upload prefix", () => {
		const prompt = `[用户本轮上传了 2 张图片，已保存到工作区：\n- /ws/a.png\n- /ws/b.png]\n\n帮我讲讲这张图`;
		expect(stripUploadedImagesPrefix(prompt)).toBe("帮我讲讲这张图");
	});

	it("leaves ordinary prompts untouched", () => {
		expect(stripUploadedImagesPrefix("  什么是贝叶斯定理？ ")).toBe("什么是贝叶斯定理？");
		expect(stripUploadedImagesPrefix("[笔记] 复习计划")).toBe("[笔记] 复习计划");
	});
});
