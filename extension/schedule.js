'use strict';

// Packages
const assign = require('lodash.assign');
const clone = require('clone');
const deepEqual = require('deep-equal');
const request = require('request-promise').defaults({jar: true}); // <= Automatically saves and re-uses cookies.

// Ours
const nodecg = require('./util/nodecg-api-context').get();
const {calcOriginalValues, mergeChangesFromTracker} = require('./lib/diff-run');

const POLL_INTERVAL = 60 * 1000;
let updateInterval;

const checklist = require('./checklist');
const currentRunRep = nodecg.Replicant('currentRun', {defaultValue: {}});
const nextRunRep = nodecg.Replicant('nextRun', {defaultValue: {}});
const runnersRep = nodecg.Replicant('runners', {defaultValue: [], persistent: false});
const runOrderMap = nodecg.Replicant('runOrderMap', {defaultValue: {}, persistent: false});
const scheduleRep = nodecg.Replicant('schedule', {defaultValue: [], persistent: false});

// If the appropriate config params are present,
// automatically update the Twitch game and title when currentRun changes.
if (nodecg.bundleConfig.twitch && nodecg.bundleConfig.twitch.titleTemplate) {
	nodecg.log.info('Automatic stream title updating enabled.');
	let lastLongName;
	currentRunRep.on('change', newVal => {
		if (newVal.longName === lastLongName) {
			return;
		}

		nodecg.log.info('Updating Twitch title and game to', newVal.longName);
		lastLongName = newVal.longName;
		request({
			method: 'put',
			uri: `https://api.twitch.tv/kraken/channels/${nodecg.bundleConfig.twitch.channelId}`,
			headers: {
				Accept: 'application/vnd.twitchtv.v5+json',
				Authorization: `OAuth ${nodecg.bundleConfig.twitch.oauthToken}`,
				'Content-Type': 'application/json'
			},
			body: {
				channel: {
					// eslint-disable-next-line no-template-curly-in-string
					status: nodecg.bundleConfig.twitch.titleTemplate.replace('${gameName}', newVal.longName),
					game: newVal.longName
				}
			},
			json: true
		}).then(() => {
			nodecg.log.info('Successfully updated Twitch title and game to', newVal.longName);
		}).catch(err => {
			nodecg.log.error('Failed updating Twitch title and game:\n\t', err);
		});
	});
}

update();

// Get latest schedule data every POLL_INTERVAL milliseconds
nodecg.log.info('Polling schedule every %d seconds...', POLL_INTERVAL / 1000);
updateInterval = setInterval(update, POLL_INTERVAL);

// Dashboard can invoke manual updates
nodecg.listenFor('updateSchedule', (data, cb) => {
	nodecg.log.info('Manual schedule update button pressed, invoking update...');
	clearInterval(updateInterval);
	updateInterval = setInterval(update, POLL_INTERVAL);
	update().then(updated => {
		if (updated) {
			nodecg.log.info('Schedule successfully updated');
		} else {
			nodecg.log.info('Schedule unchanged, not updated');
		}

		cb(null, updated);
	}, error => {
		cb(error);
	});
});

nodecg.listenFor('nextRun', cb => {
	_seekToNextRun();
	if (typeof cb === 'function') {
		cb();
	}
});

nodecg.listenFor('previousRun', cb => {
	_seekToPreviousRun();
	if (typeof cb === 'function') {
		cb();
	}
});

nodecg.listenFor('setCurrentRunByOrder', (order, cb) => {
	try {
		_seekToArbitraryRun(order);
	} catch (e) {
		nodecg.log.error(e);
		return cb(e);
	}

	if (typeof cb === 'function') {
		cb();
	}
});

nodecg.listenFor('modifyRun', (data, cb) => {
	let run;
	if (currentRunRep.value.pk === data.pk) {
		run = currentRunRep.value;
	} else if (nextRunRep.value.pk === data.pk) {
		run = nextRunRep.value;
	}

	if (run) {
		const original = findRunByPk(run.pk);
		if (original) {
			assign(run, data);
			run.originalValues = calcOriginalValues(run, original);
		} else {
			nodecg.log.error('[modifyRun] Found current/next run, but couldn\'t find original in schedule. Aborting.');
		}
	} else {
		console.warn('[modifyRun] run not found:', data);
	}

	if (typeof cb === 'function') {
		cb();
	}
});

nodecg.listenFor('resetRun', (pk, cb) => {
	let runRep;
	if (currentRunRep.value.pk === pk) {
		runRep = currentRunRep;
	} else if (nextRunRep.value.pk === pk) {
		runRep = nextRunRep;
	}

	if (runRep) {
		runRep.value = clone(findRunByPk(pk));
		if ({}.hasOwnProperty.call(runRep.value, 'originalValues')) {
			nodecg.log.error('%s had an `originalValues` property after being reset! This is bad! Deleting it...',
				runRep.value.name);
			delete runRep.value.originalValues;
		}
	}

	if (typeof cb === 'function') {
		cb();
	}
});

/**
 * Gets the latest schedule info from the GDQ tracker.
 * @returns {Promise} - A a promise resolved with "true" if the schedule was updated, "false" if unchanged.
 */
function update() {
	const runnersPromise = request({
		uri: nodecg.bundleConfig.useMockData ?
			'https://dl.dropboxusercontent.com/u/6089084/gdq_mock/runners.json' :
			'https://private.gamesdonequick.com/tracker/search',
		qs: {
			type: 'runner',
			event: 20
		},
		json: true
	});

	const runsPromise = request({
		uri: nodecg.bundleConfig.useMockData ?
			'https://dl.dropboxusercontent.com/u/6089084/gdq_mock/schedule.json' :
			'https://private.gamesdonequick.com/tracker/search',
		qs: {
			type: 'run',
			event: 20
		},
		json: true
	});

	const adsPromise = request({
		uri: nodecg.bundleConfig.useMockData ?
			'https://dl.dropboxusercontent.com/u/6089084/gdq_mock/ads.json' :
			'https://private.gamesdonequick.com/tracker/gdq/ads/20/',
		json: true
	});

	const interviewsPromise = request({
		uri: nodecg.bundleConfig.useMockData ?
			'https://dl.dropboxusercontent.com/u/6089084/gdq_mock/interviews.json' :
			'https://private.gamesdonequick.com/tracker/gdq/interviews/20/',
		json: true
	});

	return Promise.all([
		runnersPromise, runsPromise, adsPromise, interviewsPromise
	]).then(([runnersJSON, runsJSON, adsJSON, interviewsJSON]) => {
		const formattedRunners = [];
		runnersJSON.forEach(obj => {
			formattedRunners[obj.pk] = {
				stream: obj.fields.stream.split('/').filter(part => part).pop(),
				name: obj.fields.name
			};
		});

		if (!deepEqual(formattedRunners, runnersRep.value)) {
			runnersRep.value = clone(formattedRunners);
		}

		const formattedSchedule = calcFormattedSchedule({
			rawRuns: runsJSON,
			formattedRunners,
			formattedAds: adsJSON.map(formatAd),
			formattedInterviews: interviewsJSON.map(formatInterview)
		});

		// If nothing has changed, return.
		if (deepEqual(formattedSchedule, scheduleRep.value)) {
			return false;
		}

		scheduleRep.value = formattedSchedule;

		const newRunOrderMap = {};
		runsJSON.forEach(run => {
			newRunOrderMap[run.fields.name] = run.fields.order;
		});
		runOrderMap.value = newRunOrderMap;

		/* If no currentRun is set, set currentRun to the first run.
		 * Else, update the currentRun by pk, merging with and local changes.
		 */
		if (!currentRunRep.value || typeof currentRunRep.value.order === 'undefined') {
			_seekToArbitraryRun(1);
		} else {
			const currentRunAsInSchedule = findRunByPk(currentRunRep.value.pk);

			/* If currentRun was found in the schedule, merge any changes from the schedule into currentRun.
			 * Else if currentRun has been removed from the schedule (determined by its `pk`),
			 * set currentRun to whatever run now has currentRun's `order` value.
			 * If that fails, set currentRun to the final run in the schedule.
			 */
			if (currentRunAsInSchedule) {
				[currentRunRep, nextRunRep].forEach(activeRun => {
					if (activeRun.value && activeRun.value.pk) {
						const runFromSchedule = findRunByPk(activeRun.value.pk);
						activeRun.value = mergeChangesFromTracker(activeRun.value, runFromSchedule);
					}
				});
			} else {
				try {
					_seekToArbitraryRun(currentRunRep.order - 1);
				} catch (e) {
					if (e.message === 'Could not find run at specified order.') {
						const lastRunInSchedule = formattedSchedule.slice(0).reverse().find(item => item.type === 'run');
						_seekToArbitraryRun(lastRunInSchedule);
					} else {
						throw e;
					}
				}
			}
		}

		return true;
	}).catch(err => {
		nodecg.log.error('[schedule] Failed to update:', err.stack);
	});
}

/**
 * Seeks to the previous run in the schedule, updating currentRun and nextRun accordingly.
 * Clones the value of currentRun into nextRun.
 * Sets currentRun to the predecessor run.
 * @private
 * @returns {undefined}
 */
function _seekToPreviousRun() {
	const prevRun = scheduleRep.value.slice(0).reverse().find(item => {
		if (item.type !== 'run') {
			return false;
		}

		return item.order < currentRunRep.value.order;
	});

	nextRunRep.value = clone(currentRunRep.value);
	currentRunRep.value = clone(prevRun);
	checklist.reset();
}

/**
 * Seeks to the next run in the schedule, updating currentRun and nextRun accordingly.
 * Clones the value of nextRun into currentRun.
 * Sets nextRun to the new successor run.
 * @private
 * @returns {undefined}
 */
function _seekToNextRun() {
	const newNextRun = scheduleRep.value.find(item => {
		if (item.type !== 'run') {
			return false;
		}

		return item.order > nextRunRep.value.order;
	});

	currentRunRep.value = clone(nextRunRep.value);
	nextRunRep.value = clone(newNextRun);
	checklist.reset();
}

/**
 * Sets the currentRun replicant to an arbitrary run, first checking if that run is previous or next,
 * relative to any existing currentRun.
 * If so, call _seekToPreviousRun or _seekToNextRun, accordingly. This preserves local changes.
 * Else, blow away currentRun and nextRun and replace them with the new run and its successor.
 * @param {Object|Number} runOrOrder - Either a run order or a run object to set as the new currentRun.
 * @returns {undefined}
 */
function _seekToArbitraryRun(runOrOrder) {
	let run;
	let order;
	if (typeof runOrOrder === 'number') {
		order = runOrOrder;
		run = findRunByOrder(order);
	} else if (typeof runOrOrder === 'object') {
		run = runOrOrder;
		order = run.order;
	}

	if (!run) {
		throw new Error('Could not find run at specified order.');
	}

	if (nextRunRep.value && order === nextRunRep.value.order) {
		_seekToNextRun();
	} else {
		currentRunRep.value = clone(run);

		const nextRunOrder = order + 1;
		const nextRun = scheduleRep.value.find(item => item.type === 'run' && item.order === nextRunOrder);
		if (nextRun) {
			nextRunRep.value = clone(nextRun);
		} else {
			nextRunRep.value = {};
		}

		checklist.reset();
	}
}

/**
 * Generates a formatted schedule.
 * @param {Array} formattedRunners - A pre-formatted array of hydrated runner objects.
 * @param {Array} scheduleJSON - The raw schedule array from the Tracker.
 * @returns {Array} - A formatted schedule.
 */

function calcFormattedSchedule({rawRuns, formattedRunners, formattedAds, formattedInterviews}) {
	const flatSchedule = [];

	// NOTE: We *probably* don't have to do this sort step,
	// but UraniumAnchor said he wasn't 100% positive that sorting
	// was guaranteed from the API, so we do this just to be safe.

	// Sort runs by order.
	rawRuns = rawRuns.sort((a, b) => a.fields.order - b.fields.order);

	// Sort ads and interviews by order, then suborder.
	const formattedAdsAndInterviews = formattedAds.concat(formattedInterviews).sort(suborderSort);

	let lastIndex = 0;
	rawRuns.forEach(run => {
		run = formatRun(run, formattedRunners);
		flatSchedule.push(run);

		formattedAdsAndInterviews.slice(lastIndex).some((item, index) => {
			if (item.order > run.order) {
				return true;
			}

			lastIndex = index;

			// This theoretically should never be hit?
			if (item.order < run.order) {
				return false;
			}

			flatSchedule.push(item);
			return false;
		});
	});

	const schedule = [];

	let adBreak;
	flatSchedule.forEach((item, index) => {
		if (item.type === 'ad') {
			if (!adBreak) {
				adBreak = {
					type: 'adBreak',
					ads: []
				};
			}

			adBreak.ads.push(item);

			const nextItem = flatSchedule[index + 1];
			if (nextItem.type === 'ad') {
				return;
			}

			schedule.push(adBreak);
			adBreak = null;
			return;
		}

		schedule.push(item);
	});

	return schedule;
}

/**
 * Formats a raw run object from the GDQ Tracker API into a slimmed-down and hydrated version for our use.
 * @param {Object} run - A raw run object from the GDQ Tracker API.
 * @param {Object} formattedRunners - The formatted array of all runners, used to hydrate the run's runners.
 * @returns {Object} - The formatted run object.
 */
function formatRun(run, formattedRunners) {
	const runners = run.fields.runners.slice(0, 4).map(runnerId => {
		return {
			name: formattedRunners[runnerId].name,
			stream: formattedRunners[runnerId].stream
		};
	});

	return {
		name: run.fields.display_name || 'Unknown',
		longName: run.fields.name || 'Unknown',
		console: run.fields.console || 'Unknown',
		commentators: run.fields.commentators || 'Unknown',
		category: run.fields.category || 'Any%',
		setupTime: run.fields.setup_time,
		order: run.fields.order,
		estimate: run.fields.run_time || 'Unknown',
		releaseYear: run.fields.release_year || '',
		runners,
		notes: run.fields.tech_notes || '',
		coop: run.fields.coop || false,
		id: run.pk,
		pk: run.pk,
		type: 'run'
	};
}

/**
 * Formats a raw ad object from the GDQ Tracker API into a slimmed-down version for our use.
 * @param {Object} ad - A raw ad object from the GDQ Tracker API.
 * @returns {Object} - The formatted ad object.
 */
function formatAd(ad) {
	return {
		id: ad.pk,
		name: ad.fields.ad_name,
		adType: ad.fields.ad_type,
		filename: ad.fields.filename,
		length: ad.fields.length,
		order: ad.fields.order,
		suborder: ad.fields.suborder,
		sponsorName: ad.fields.sponsor_name,
		type: 'ad'
	};
}

/**
 * Formats a raw interview object from the GDQ Tracker API into a slimmed-down version for our use.
 * @param {Object} interview - A raw interview object from the GDQ Tracker API.
 * @returns {Object} - The formatted interview object.
 */
function formatInterview(interview) {
	return {
		id: interview.pk,
		interviewees: splitString(interview.fields.interviewees),
		interviewers: splitString(interview.fields.interviewers),
		length: interview.fields.length,
		order: interview.fields.order,
		subject: interview.fields.subject,
		suborder: interview.fields.suborder,
		type: 'interview'
	};
}

/**
 * Splits a comma-separated string into an array of strings, trimming whitespace.
 * @param {string} str - The string to split.
 * @return {Array<string>} - The split string.
 */
function splitString(str) {
	return str.split(',')
		.map(part => part.trim())
		.filter(part => part);
}

/**
 * Sorts objects by their `order` property, then by their `suborder` property.
 * @param {object} a - The first item in the current sort operation.
 * @param {object} b - The second item in the current sort operation.
 * @returns {number} - A number expressing which of these two items comes first in the sort.
 */
function suborderSort(a, b) {
	const orderDiff = a.order - b.order;

	if (orderDiff !== 0) {
		return orderDiff;
	}

	return a.suborder - b.suborder;
}

/**
 * Searches scheduleRep for a run with the given `order`.
 * @param {number} order - The order of the run to find.
 * @returns {object|undefined} - The found run, or undefined if not found.
 */
function findRunByOrder(order) {
	return scheduleRep.value.find(item => {
		return item.type === 'run' && item.order === order;
	});
}

/**
 * Searches scheduleRep for a run with the given `pk` (or `id`).
 * @param {number} pk - The id or pk of the run to find.
 * @returns {object|undefined} - The found run, or undefined if not found.
 */
function findRunByPk(pk) {
	return scheduleRep.value.find(item => {
		return item.type === 'run' && item.id === pk;
	});
}
