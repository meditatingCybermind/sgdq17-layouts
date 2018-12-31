(function () {
	'use strict';

	const stopwatch = nodecg.Replicant('stopwatch');

	class MmInfoNoTimer extends Polymer.Element {
		static get is() {
			return 'mm-info-no-timer';
		}

		static get properties() {
			return {
				paused: {
					type: Boolean,
					observer: 'pausedChanged',
					reflectToAttribute: true
				},
				finished: {
					type: Boolean,
					observer: 'finishedChanged',
					reflectToAttribute: true
				}
			};
		}

		pausedChanged(newVal) {
			if (newVal && this.finished) {
				this.finished = false;
			}
		}

		finishedChanged(newVal) {
			if (newVal && this.paused) {
				this.paused = false;
			}
		}
	}

	customElements.define(MmInfoNoTimer.is, MmInfoNoTimer);
})();
