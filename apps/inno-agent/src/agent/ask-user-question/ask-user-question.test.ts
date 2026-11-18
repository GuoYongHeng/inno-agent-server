import { describe, expect, it } from "vitest";
import { buildQuestionnaireResponse, DECLINE_MESSAGE } from "./response-envelope.js";
import { validateQuestionnaire } from "./validate-questionnaire.js";

const option = (label: string) => ({ label, description: `${label} description` });
const question = (text: string, labels: string[]) => ({ question: text, header: "Pick", options: labels.map(option) });

describe("vendored ask_user_question support", () => {
	it("accepts a well-formed questionnaire", () => {
		expect(validateQuestionnaire({ questions: [question("Which one?", ["A", "B"])] })).toEqual({ ok: true });
	});

	it.each([
		["too few options", { questions: [question("Q?", ["A"])] }, "empty_options"],
		["duplicate question text", { questions: [question("Q?", ["A", "B"]), question("Q?", ["C", "D"])] }, "duplicate_question"],
		["duplicate option labels", { questions: [question("Q?", ["A", "A"])] }, "duplicate_option_label"],
		["reserved label", { questions: [question("Q?", ["Other", "B"])] }, "reserved_label"],
		["reserved sentinel label", { questions: [question("Q?", ["Type something.", "B"])] }, "reserved_label"],
		["no questions", { questions: [] }, "no_questions"],
	])("rejects %s", (_name, params, error) => {
		expect(validateQuestionnaire(params)).toMatchObject({ ok: false, error });
	});

	it("turns answers into the model-facing envelope", () => {
		const params = { questions: [question("Which one?", ["A", "B"])] };
		const response = buildQuestionnaireResponse({
			answers: [{ questionIndex: 0, question: "Which one?", kind: "option", answer: "B" }],
			cancelled: false,
		}, params);
		expect(response.content[0]!.text).toContain('"Which one?"="B"');
	});

	it("reports a decline for cancelled or empty results", () => {
		const params = { questions: [question("Which one?", ["A", "B"])] };
		expect(buildQuestionnaireResponse({ answers: [], cancelled: true }, params).content[0]!.text).toBe(DECLINE_MESSAGE);
		expect(buildQuestionnaireResponse(null, params).content[0]!.text).toBe(DECLINE_MESSAGE);
	});
});
