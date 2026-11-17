CI R2 fixes the two real failures from the previous head. The zh-TW label and search keyword now use the existing wording 實際名稱; English remains Instance name. The Preferences regression test finds the HTML preview label through `#pref-previews` instead of the first checkbox-style label in the section. Its original text, confirmation and opt-in assertions remain.

The exact old behavior reproduces two semantic assertion failures with ten controls passing. The fixed vocabulary, footer and compact-name suites pass 20/20. Runtime preference/identity/storage logic is unchanged. A label-only option in the manual capture script allows retaking just the two affected phone control views. Earlier English and row captures keep their original scope.

Phone-only actual app retake: 14/14 controls pass. The two preferred `after/phone-customize.png` and `after/phone-settings.png` now bind source ba2208c561a0e9893942356a30698cdfc7f057bc. Previous versions are retained under `r2/before/`. No other captures or broad campaign are repeated.

Independent image-only review clears both updated phone views: one selected option, readable labels and visible Save/Discard controls.

Raw baseline/final transcripts are stored as lossless gzip files to preserve their trailing blank lines.
