// test
const { execSync, spawn } = require('child_process');
const { existsSync } = require('fs');
const { EOL } = require('os');
const path = require('path');

// Change working directory if user defined PACKAGEJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

const workspace = process.env.GITHUB_WORKSPACE;

(async () => {
  const pkg = getPackageJson();
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  if (!event.commits) {
    console.log("Couldn't find any commits in this event, incrementing patch version...");
  }

  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  const messages = event.commits ? event.commits.map((commit) => commit.message + '\n' + commit.body) : [];

  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  console.log('commit messages:', messages);
  const commitMessageRegex = new RegExp(commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+`), 'ig');
  const isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;

  if (isVersionBump) {
    return exitSuccess('No action necessary because we found a previous bump!');
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWord = process.env['INPUT_MAJOR-WORDING'];
  const minorWord = process.env['INPUT_MINOR-WORDING'];
  // patch is by default empty, and '' would always be true in the includes(''), thats why we handle it separately
  const patchWord = process.env['INPUT_PATCH-WORDING'] || '';
  const preReleaseWord = process.env['INPUT_RC-WORDING'] || '';

  const beforeCommit = process.env['INPUT_COMMIT-BEFORE'] || null;

  console.log('config words:', { majorWord, minorWord, patchWord, preReleaseWord, beforeCommit });

  // get default version bump
  let version = process.env.INPUT_DEFAULT;
  let foundWord = null;
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID;

  const majorDefaultRegex = /^([a-zA-Z]+)(\(.+\))?(\!)\:/;

  // message check with word
  const matchMajorWord = messages.some((message) => {
    return majorDefaultRegex.test(message) || matchPattern(message, majorWord);
  });
  const matchMinorWord = messages.some((message) => {
    return matchPattern(message, minorWord);
  });
  const matchPatchWord = messages.some((message) => {
    return matchPattern(message, patchWord);
  });
  const matchPreReleaseWord = messages.some((message) => {
    return matchPattern(message, preReleaseWord);
  });

  if (matchMajorWord) version = 'major';
  else if (matchMinorWord) version = 'minor';
  else if (patchWord && matchPatchWord) version = 'patch';
  else if (preReleaseWord) {
    const message = messages.find((message) => matchPattern(message, preReleaseWord));
    if (message) {
      const wordRegExp = convertToRegExp(preReleaseWord);
      foundWord = message.match(wordRegExp)[0];
      preid = foundWord.split('-')[1];
      version = 'prerelease';
    }
  }

  console.log('version action after first waterfall:', version);

  // case: if default=prerelease,
  // rc-wording is also set
  // and does not include any of rc-wording
  // then unset it and do not run
  if (version === 'prerelease' && preReleaseWord && !matchPreReleaseWord) {
    version = null;
  }

  // case: if default=prerelease, but rc-wording is NOT set
  if (version === 'prerelease' && preid) {
    version = `prerelease --preid=${preid}`;
  }

  console.log('version action after final decision:', version);

  // case: if nothing of the above matches
  if (version === null) {
    return exitSuccess('No version keywords found, skipping bump.');
  }

  // case: if user sets push to false, to skip pushing new tag/package.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    return exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
  }

  // GIT logic
  try {
    const current = pkg.version.toString();
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`,
    ]);

    let currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1];
    let isPullRequest = false;
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF;
      isPullRequest = true;
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('currentBranch:', currentBranch);
    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the package.json version
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    let newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    newVersion = `${tagPrefix}${newVersion}`;
    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      if (beforeCommit) {
        const commitArr = beforeCommit.split(' ');
        const args = commitArr.slice(1);
        await runInWorkspace(commitArr[0], args);
      }
      await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
    }

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    await runInWorkspace('git', ['checkout', currentBranch]);
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    newVersion = `${tagPrefix}${newVersion}`;
    console.log(`::set-output name=newTag::${newVersion}`);
    try {
      // to support "actions/checkout@v1"
      if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
        if (beforeCommit) {
          const commitArr = beforeCommit.split(' ');
          const args = commitArr.slice(1);
          await runInWorkspace(commitArr[0], args);
        }
        await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
      }
    } catch (e) {
      console.warn(
        'git commit failed because you are using "actions/checkout@v2"; ' +
          'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"',
      );
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await runInWorkspace('git', ['tag', newVersion]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function getPackageJson() {
  const pathToPackage = path.join(workspace, 'package.json');
  if (!existsSync(pathToPackage)) throw new Error("package.json could not be found in your project's root.");
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
  //return execa(command, args, { cwd: workspace });
}

function matchPattern(message, word) {
  const regex = convertToRegExp(word);
  return regex.test(message);
}

function convertToRegExp(text) {
  if (text.match(/^\/.+\/[gmixXsuUAJ]*$/)) {
    return regexParser(text);
  } else return new RegExp(text, 'g');
}

function regexParser(text) {
  const m = text.match(/(\/?)(.+)\1([a-z]*)/i);
  if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
    return RegExp(text);
  } else {
    return new RegExp(m[2], m[3]);
  }
}
