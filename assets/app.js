'use strict';

import $ from 'jquery';
import 'bootstrap/js/dropdown';
import 'bootstrap/js/modal';

/**
 * @class
 * @property {HTMLFormElement} filtersForm
 */
class CopyPatrol {

	constructor() {
		this.filtersForm = document.forms[ 'filters-form' ];

		// Cached jQuery selectors.
		this.$records = $( '.records' );

		// Constants
		this.STATUS_READY = 0;
		this.STATUS_FIXED = 1;
		this.STATUS_NO_ACTION = 2;
	}

	addListeners() {
		this.$records.on( 'click', '.save-status', this.saveStatus.bind( this ) );
		this.$records.on( 'click', '.compare-button', this.toggleComparePane.bind( this ) );
		$( '.btn-load-more' ).on( 'click', this.loadMoreResults );

		// enable additional search features based on active filter
		$( this.filtersForm.elements.filter ).on( 'change', () => {
			const newFilter = this.filtersForm.elements.filter.value;
			this.filtersForm.setAttribute( 'data-filter', newFilter );
		} );
		// set the filter where the radio value may have been remembered from a page reload
		this.filtersForm.setAttribute( 'data-filter', this.filtersForm.elements.filter.value );
	}

	/**
	 * Open the compare pane and do an AJAX request to Copyvios to fetch comparison data.
	 *
	 * @param {Event} e
	 */
	toggleComparePane( e ) {
		const params = e.target.dataset,
			$compareDiv = $( '#comp' + params.id + '-' + params.index );

		$compareDiv.slideToggle( 500 );
		if ( !$compareDiv.hasClass( 'copyvios-fetched' ) ) {
			$.ajax( {
				type: 'GET',
				url: 'https://copyvios.toolforge.org/api.json',
				data: {
					oldid: params.oldid,
					url: params.url,
					action: 'compare',
					project: 'wikipedia',
					lang: wikiLang,
					format: 'json',
					detail: 'true'
				},
				dataType: 'json',
				jsonpCallback: 'callback'
			} ).always( ( ret ) => {
				// use always() to handle 500s, etc.
				if ( ret.detail ) { // ret.detail means we had success
					const $leftPane = $compareDiv.find( '.compare-pane-left-body' ),
						$rightPane = $compareDiv.find( '.compare-pane-right-body' );

					// Add class to compare panel once we fetch to avoid repetitive API requests.
					$leftPane.html( ret.detail.article );
					$rightPane.html( ret.detail.source );

					// Fetch the first instance of a match and auto-scroll to it.
					// (-20 to account for line height and another 20 for some offset padding)
					const leftMatch = $leftPane.find( '.cv-hl' )[ 0 ],
						rightMatch = $rightPane.find( '.cv-hl' )[ 0 ];
					if ( leftMatch ) {
						$leftPane.scrollTop( leftMatch.offsetTop - 40 );
					}
					if ( rightMatch ) {
						$rightPane.scrollTop( rightMatch.offsetTop - 40 );
					}
				} else {
					// Use API-provided error message, otherwise a blanket unknown
					//   error message as it could be unrelated to the API.
					const errorMessage = ret.error && ret.error.info ?
						ret.error.info :
						jsUnknownError;
					$compareDiv.find( '.compare-pane-body' )
						.html( '<span class="text-danger">' + errorMessage + '</span>' );
				}
			} );

			// Add fetched class immediately, so if they close/open the pane
			// it doesn't keep making requests while the initial one hasn't finished.
			$compareDiv.addClass( 'copyvios-fetched' );
		}
	}

	saveStatus( e ) {
		const status = parseInt( e.target.dataset.status, 10 ),
			submissionId = e.target.dataset.submissionId,
			currentStatus = parseInt( $( `.record-${submissionId}` ).data( 'status' ), 10 );
		let reviewFn;

		$( e.target ).addClass( 'loading' );

		// undo review if they click on the button with the same status as the record
		if ( status === currentStatus ) {
			reviewFn = this.undoReview;
		} else {
			reviewFn = this.saveReview;
		}

		// perform review action then cleanup
		reviewFn.call( this, submissionId, status ).done( () => {
			// Close compare areas.
			$( e.target ).parents( 'article.record' ).find( '.compare-pane' ).slideUp();
		} ).fail( ( ret ) => {
			const error = ret.responseJSON ? ret.responseJSON.error : null;

			if ( error === 'unauthorized' ) {
				window.alert( jsUnauthorized );
			} else if ( error === 'blocked' ) {
				// Refresh the page, which will then show the blocked message.
				window.location.reload();
			} else if ( error === 'database' ) {
				window.alert( jsDbError );
			} else if ( error === 'wrong_user' ) {
				window.alert( jsUndoOwnOnly );
			} else {
				window.alert( 'Something went wrong. Please try again.' );
			}

			// go back to initial status
			this.setReviewStatus( submissionId, currentStatus );
		} ).always( () => {
			// remove focus from button
			document.activeElement.blur();
			$( e.target ).removeClass( 'loading' );
		} );
	}

	/**
	 * Save a review
	 *
	 * @param {string|number} submissionId Submission ID of the record
	 * @param {number} status
	 * @return {jQuery<Promise>}
	 */
	saveReview( submissionId, status ) {
		// update styles before AJAX to make it seem more responsive
		this.setReviewStatus( submissionId, status );

		return $.ajax( {
			method: 'PUT',
			url: `/${wikiLang}/review_add/${submissionId}/${status}`,
			dataType: 'json'
		} ).done( ( ret ) => {
			const $reviewerNode = $( '.status-div-reviewer-' + submissionId );
			$reviewerNode.find( '.reviewer-link' )
				.prop( 'href', ret.userpage )
				.text( ret.user );
			$reviewerNode.find( '.reviewer-timestamp' )
				.text( ret.timestamp );
			$reviewerNode.fadeIn( 'slow' );
		} );
	}

	/**
	 * Undo a review
	 *
	 * @param {string|number} submissionId Submission ID of the record
	 * @return {jQuery<Promise>}
	 */
	undoReview( submissionId ) {
		return $.ajax( {
			method: 'PUT',
			url: `/${wikiLang}/review_undo/${submissionId}`,
			dataType: 'json'
		} ).done( () => {
			const $reviewerNode = $( `.status-div-reviewer-${submissionId}` );
			$reviewerNode.fadeOut( 'slow' );
			this.setReviewStatus( submissionId, this.STATUS_READY );
		} );
	}

	/**
	 * Set the CSS class of the record in view, which updates the appearance of the review buttons.
	 *
	 * @param {string|number} submissionId Submission ID of the record
	 * @param {string|number} status One of the this.STATUS_ constants.
	 */
	setReviewStatus( submissionId, status ) {
		$( '.record-' + submissionId )
			.removeClass( 'record-status-0' )
			.removeClass( 'record-status-1' )
			.removeClass( 'record-status-2' )
			.addClass( `record-status-${status}` )
			.data( 'status', status );
	}

	/**
	 * Load more results to the page when 'Load More' is clicked
	 */
	loadMoreResults() {
		$( '#btn-load-more' ).text( '' ).addClass( 'btn-loading' );
		const lastId = $( '.record:last' ).data( 'diffId' ),
			params = new URLSearchParams( location.search );
		params.set( 'lastid', lastId );
		$.ajax( { url: `/${wikiLang}?${params}` } ).done( ( ret ) => {
			$( '#btn-load-more' ).text( 'Load More' )
				.removeClass( 'btn-loading' );
			const $newRecords = $( ret ).find( '.record-container' );

			if ( $newRecords.find( '.record' ).length ) {
				$( '.record-container' ).append( $newRecords.html() );
			} else {
				$( '.btn-load-more' ).replaceWith( '<p>' + jsNoMore + '</p>' );
			}
		} ).fail( function () {
			window.alert( jsUnknownError );
			$( '#btn-load-more' ).text( jsLoadMore ).removeClass( 'btn-loading' );
		} );
	}
}

$( () => {
	const copyPatrol = new CopyPatrol();
	if ( $( '.record' ).length ) {
		copyPatrol.addListeners();
	}
} );
