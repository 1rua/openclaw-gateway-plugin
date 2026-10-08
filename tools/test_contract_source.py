#!/usr/bin/env python3
"""Contract pin parsing checks that do not need a Git checkout."""

from __future__ import annotations

import unittest

from contract_source import ContractPinError, EXPECTED_REPOSITORY, parse_contract_pin


class ParseContractPinTest(unittest.TestCase):
    def test_accepts_repository_and_full_revision(self) -> None:
        self.assertEqual(
            parse_contract_pin({"repository": EXPECTED_REPOSITORY, "revision": "a" * 40}),
            (EXPECTED_REPOSITORY, "a" * 40),
        )

    def test_rejects_non_object_json_roots(self) -> None:
        for value in (None, [], "pin", 1):
            with self.subTest(value=value), self.assertRaisesRegex(ContractPinError, "顶层必须是 JSON 对象"):
                parse_contract_pin(value)

    def test_rejects_wrong_repository(self) -> None:
        with self.assertRaisesRegex(ContractPinError, "repository 必须为"):
            parse_contract_pin({"repository": "https://example.invalid/repo.git", "revision": "a" * 40})

    def test_rejects_non_full_revision(self) -> None:
        with self.assertRaisesRegex(ContractPinError, "40 位小写十六进制"):
            parse_contract_pin({"repository": EXPECTED_REPOSITORY, "revision": "A" * 40})

    def test_rejects_non_string_fields(self) -> None:
        with self.assertRaisesRegex(ContractPinError, "repository 必须是字符串"):
            parse_contract_pin({"repository": 1, "revision": "a" * 40})
        with self.assertRaisesRegex(ContractPinError, "revision 必须是字符串"):
            parse_contract_pin({"repository": EXPECTED_REPOSITORY, "revision": int("1" * 40)})


if __name__ == "__main__":
    unittest.main()
