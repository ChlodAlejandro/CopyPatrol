<?php
/**
 * This file is part of CopyPatrol application
 * Copyright (C) 2016  Niharika Kohli and contributors
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @author Niharika Kohli <nkohli@wikimedia.org>
 * @copyright © 2016 Niharika Kohli and contributors.
 */
namespace Plagiabot\Web\Controllers\API;

use GuzzleHttp;
use Plagiabot\Web\Controllers\CopyPatrol;

class APIRecords extends CopyPatrol {

	/**
	 * Handle GET route for app.
	 *
	 * Similar to {@link CopyPatrol::handleGet}, but returns JSON instead of HTML.
	 * In addition, inferrable attributes are dropped (links to pages, etc.).
	 *
	 * Unlike {@link CopyPatrol::handleGet}, this method does not return anything.
	 *
	 * @param int|null $id The ID of the record to fetch. Set to `null` to fetch max no. of records.
	 */
	protected function handleGet( $id = null ) {
		// Check if they are blocked on the requested wiki, and if so deny access.
		if ( $this->isUserBlocked() ) {
			$this->slim->response->setStatus( 403 );
			API::respond( $this->slim, [
				"error" => [
					"code" => "blocked",
					"info" => "You are blocked on this wiki."
				]
			] );
			return;
		}

		$records = $this->getRecords( $id );
		// nothing else needs to be done if there are no records
		if ( empty( $records ) ) {
			API::respond( $this->slim, [
				"records" => []
			] );
			return;
		}
		$userWhitelist = $this->getUserWhitelist();
		$diffIds = [];
		$pageTitles = [];
		$usernames = [];
		// first build arrays of diff IDs and page titles so we can use them to make mass queries
		foreach ( $records as $record ) {
			$diffIds[] = $record['diff'];
			// make sure drafts have the namespace prefix
			if ( $record['page_ns'] == 118 ) {
				$record['page_title'] = 'Draft:' . $record['page_title'];
			}
			$pageTitles[] = $record['page_title'];
		}
		// get an associative array with the revision ID as the key and editor as the value
		// this makes it easier to access what we need when looping through the copyvio records
		$editors = $this->wikiDao->getRevisionsEditors( $diffIds );
		foreach ( $editors as $editor ) {
			// add username to usernames array so we can fetch their edit counts all at once
			$usernames[] = $editor;
		}
		// Asynchronously get edit counts of users,
		// and all dead pages so we can colour them red in the view
		$promises = [
			'editCounts' => $this->wikiDao->getEditCounts( $usernames ),
			'deadPages' => $this->wikiDao->getDeadPages( $pageTitles )
		];
		$asyncResults = GuzzleHttp\Promise\unwrap( $promises );
		$editCounts = $asyncResults['editCounts'];
		$deadPages = $asyncResults['deadPages'];
		// Get ORES scores for edits
		$oresScores = $this->oresScores( $diffIds );
		// now all external requests and database queries (except
		// WikiProjects) have been completed, let's loop through the records
		// once more to build the complete dataset to be rendered into view
		foreach ( $records as $key => $record ) {
			// sanitize values
			// convert integer values to integers
			foreach ( [ 'id', 'page_ns', 'diff', 'ithenticate_id' ] as $field ) {
				if ( isset( $record[$field] ) ) {
					$records[$key][$field] = intval( $record[$field] );
				}
			}

			$editor = null;
			if ( isset( $record['diff'] ) && isset( $editors[$record['diff']] ) ) {
				$editor = $editors[$record['diff']];
			}

			// mark it as reviewed by our bot and skip if editor is in user whitelist
			if ( in_array( $editor, $userWhitelist ) && $this->getFilter() === 'open' ) {
				$this->autoReview( $record['ithenticate_id'] );
				unset( $records[$key] );
				continue;
			}
			if ( $record['page_ns'] == 118 ) {
				$record['page_title'] = 'Draft:' . $record['page_title'];
			}
			$pageDead = in_array( $record['page_title'], $deadPages );
			// If the page is dead and this is not a permalink,
			// mark it as reviewed by our bot and skip to next record
			if ( $pageDead && $this->getFilter() === 'open' && !$this->view->get( 'permalink' ) ) {
				$this->autoReview( $record['ithenticate_id'] );
				unset( $records[$key] );
				continue;
			} else {
				$records[$key]['page_dead'] = $pageDead;
			}
			$records[$key]['diff_timestamp'] = $this->formatTimestamp( $record['diff_timestamp'] );
			$records[$key]['copyvios'] = $this->getSources( $record['report'] );
			if ( $editor ) {
				$records[$key]['editcount'] = $editCounts[$editor];
				$records[$key]['editor'] = $editor;
			}
			if ( $records[$key]['status_user'] ) {
				$records[$key]['reviewed_by_url'] = $this->getUserPage( $record['status_user'] );
				$records[$key]['review_timestamp'] = $this->formatTimestamp( $record['review_timestamp'] );
			}
			$records[$key]['wikiprojects'] = $this->dao->getWikiProjects(
				$this->wikiDao->getLang(), $record['page_title']
			);
			$records[$key]['page_title'] = $this->removeUnderscores( $record['page_title'] );
			$cleanWikiprojects = [];
			foreach ( $records[$key]['wikiprojects'] as $k => $wp ) {
				$wp = $this->removeUnderscores( $wp );
				$cleanWikiprojects[] = $wp;
			}
			$records[$key]['wikiprojects'] = $cleanWikiprojects;
			if ( $oresScores[$record['diff']] && $oresScores[$record['diff']] > 0.427 ) {
				$records[$key]['oresScore'] = $oresScores[$record['diff']];
			}

			// Clean up, remove the "report" string since we don't need it.
			unset( $records[$key]['report'] );
		}

		API::respond( $this->slim, [
			"records" => $records
		] );
	}

	/**
	 * Get URLs and scores for the copyvio sources.
	 *
	 * This returns decimal percentages and integer counts instead of strings.
	 *
	 * @param string $text Blob from db
	 * @return array Associative array with URLs and scores
	 */
	public function getSources( $text ) {
		// matches '[new line] ... (digits followed by %) (digits) ... (the URL)[word break]'
		preg_match_all( '#\n\*.*?(\d+)%\s+(\d+).*?\b(https?://[^\s()<>]+)\b#', $text, $matches );
		// sometimes no URLs are given at all, or they are invalid. If so just return empty array
		if ( !$matches[0] ) {
			return [];
		}
		$sources = [];
		// $matches is an array containing an array of percentages, counts and urls
		// Here we collect them so that each index in $sources represents a single entity
		foreach ( $matches[1] as $index => $percentage ) {
			$sources[] = [
				'percentage' => intval( $percentage ) * 0.01,
				'count' => intval( $matches[2][$index] ),
				'url' => $matches[3][$index]
			];
		}
		return $sources;
	}
}
