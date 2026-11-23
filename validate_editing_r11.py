"""Exercise verified customer packages with generated test media and no user assets."""
from argparse import ArgumentParser
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import platform
from shutil import copytree
import stat
import subprocess
import sys
from zipfile import ZipFile

SKILL_SHA = 'd487a484efea5bd180c6b321aa7520d40f57f50f0f3d9555fe09e485a091476c'
TEMPLATE_SHA = 'a590f6ccd14a42faf8d78afa97847fa82e9b7ca2e25b0c4c29abdc3966d0c657'
SKILL_DIR = '.codebuddy/skills/ai-video-editing-post'


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    with path.open('x', encoding='utf-8') as file:
        json.dump(value, file, ensure_ascii=False, indent=2)


def install(package, profile):
    assert digest(package) == SKILL_SHA
    extracted = profile / 'extracted'
    with ZipFile(package) as archive:
        files = archive.infolist()
        assert len({f.filename for f in files}) == len(files)
        for file in files:
            path = PurePosixPath(file.filename)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in file.filename and ':' not in file.filename
            assert not stat.S_ISLNK(file.external_attr >> 16)
            assert file.filename == 'START.md' or file.filename.startswith('.codebuddy/')
        archive.extractall(extracted)
    skill = profile / '.workbuddy' / 'skills' / 'ai-video-editing-post'
    copytree(extracted / SKILL_DIR, skill)
    manifest = read_json(skill / 'distribution.json')
    assert manifest['version'] == '0.3.3-r11' and len(manifest['files']) == 68
    for name, expected in manifest['files'].items():
        assert digest(skill / name) == expected, name
    return skill


def command(*args):
    subprocess.run([str(a) for a in args], check=True,
                   env=dict(os.environ, PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1'))


def create_example(root, source):
    command('ffmpeg', '-hide_banner', '-loglevel', 'error', '-n',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6',
            '-f', 'lavfi', '-i', 'sine=frequency=375:sample_rate=48000:duration=6',
            '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-shortest', source)
    phrase = '测试剪辑流程'
    evidence = root / 'fixed-test-word-timing.json'
    write_json(evidence, {
        'source': {'path': str(source), 'sha256': digest(source)},
        'provenance': {'sourceOffsetSeconds': 0, 'qualityStatus': 'pending_audio_review',
                       'timingPrecision': 'synthetic_fixture', 'syntheticFixtureOnly': True},
        'analysis': {'text': phrase, 'words': [
            {'word': char, 'start': .4 + i * .25, 'end': .6 + i * .25, 'probability': 1}
            for i, char in enumerate(phrase)
        ]},
    })
    return phrase, evidence


def run(args):
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    assert (args.template.is_file() and digest(args.template) == TEMPLATE_SHA)
    skill = install(args.skill, root / '测试用户 profile')
    browser = args.browser.resolve(strict=True)
    deps = args.node_modules.resolve(strict=True)
    reports = {}

    def review(action, *options):
        print('R11:', action, flush=True)
        command(sys.executable, '-X', 'utf8', skill / 'scripts/talking_head_review.py', action, *options)

    environment_path = root / 'environment.json'
    with environment_path.open('xb') as file:
        subprocess.run([sys.executable, '-X', 'utf8', str(skill / 'scripts/talking_head_environment.py'),
                        '--node-modules', str(deps), '--browser', str(browser)], stdout=file, check=True)
    environment = read_json(environment_path)
    assert environment['local_render_ready'] and environment['missing'] == [], environment['missing']
    reports['installedFilesVerified'] = 68

    source = root / '口播样片 source.mp4'
    phrase, evidence = create_example(root, source)
    prepared_dir = root / 'prepared'
    prepared = prepared_dir / 'prepared.json'
    review('prepare', '--source', source, '--template', args.template, '--out', prepared_dir)
    review('transcript', '--prepared', prepared, '--word-evidence', evidence, '--out', root / 'transcript')
    receipt = read_json(root / 'transcript/transcript-consumption.internal.json')
    assert receipt['status'] == 'evidence_bound_not_audio_review_approved'
    job = read_json(prepared)['draft_job']
    job['word_evidence'] = receipt['word_evidence']
    job['scenes'] = [
        {'id': 'opening', 'kind': 'host', 'first': 0, 'end': 75,
         'titles': [{'text': '中文剪辑测试', 'frame': 8, 'end': 75, 'x': 780, 'y': 64, 'size': 82}]},
        {'id': 'motion-cards', 'kind': 'cards', 'first': 75, 'end': job['frames'],
         'heading': '用原模板生成', 'headingFrame': 80, 'moveStart': 75, 'moveDuration': 10,
         'labels': [{'text': '创建成片', 'frame': 84}, {'text': '保存并重开', 'frame': 105}]},
    ]
    job['captions'] = [{'id': 'caption-test', 'text': phrase, 'expected_spoken_text': phrase,
                       'start': .4, 'end': .6 + (len(phrase)-1)*.25, 'evidence_word_start_index': 0,
                       'evidence_word_end_index': len(phrase), 'alignment_method': 'final_audio_word_timestamps',
                       'text_review_source': 'asr_candidate_not_confirmed'}]
    job_path = root / 'job.json'
    write_json(job_path, job)
    draft = root / 'draft'
    review('make', '--prepared', prepared, '--job', job_path, '--out', draft,
           '--node-modules', deps, '--browser', browser, '--draft')
    assert read_json(draft / 'motion-cards-cards-receipt.json')['frames'] == job['frames']-75
    project = read_json(draft / 'project.json')
    assert project['reuse']['completed_film_cache_used'] is False
    media = Path(project['identity']['media']['path'])
    assert media.is_file() and digest(media) == project['identity']['media']['sha256']
    assert (draft / 'review.html').is_file()
    reports.update(renderedFrames=job['frames'], renderDimensions=[1280, 720], mediaSHA256=digest(media))
    snapshot = root / 'saved-project.json'
    review('save', '--project', draft / 'project.json', '--out', snapshot)
    resumed = root / 'resumed'
    review('resume', '--snapshot', snapshot, '--out', resumed)
    review('inspect', '--project', resumed / 'project.json')
    reopened = read_json(resumed / 'project.json')
    assert project['identity'] == reopened['identity']
    assert (resumed / 'review.html').is_file()
    assert digest(media) == project['identity']['media']['sha256']
    reports.update(state='passed', platform=platform.system(), machine=platform.machine(),
                   skillVersion='0.3.3-r11', madeAndReopened=True, asrTested=False, externalGenerations=0)
    write_json(root / 'validation.json', reports)
    print(json.dumps(reports, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = ArgumentParser()
    for option in ('skill', 'template', 'node-modules', 'browser', 'output'):
        parser.add_argument('--' + option, type=Path, required=True)
    run(parser.parse_args())
