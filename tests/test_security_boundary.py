import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]


class DeploymentSecurityBoundaryTest(unittest.TestCase):
    def test_public_entry_contains_keychain_boundary(self):
        text = (ROOT / "CODEX_DEPLOYMENT.md").read_text(encoding="utf-8")
        self.assertIn("禁止运行全量钥匙串导出或扫描命令", text)
        self.assertIn("不要要求使用者输入密码", text)
        self.assertIn("改用不读取浏览器密钥", text)

    def test_deployment_scripts_do_not_dump_keychain(self):
        offenders = []
        for path in (ROOT / "scripts").rglob("*"):
            if path.is_file() and path.suffix.lower() in {".py", ".sh", ".command", ".bat"}:
                if "dump-keychain" in path.read_text(encoding="utf-8", errors="replace"):
                    offenders.append(str(path))
        self.assertEqual([], offenders)


if __name__ == "__main__":
    unittest.main()
