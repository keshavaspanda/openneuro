import React, { useContext } from 'react'
import { gql, useQuery } from '@apollo/client'
import { SearchParamsCtx } from './search-params-ctx'
import {
  BoolQuery,
  simpleQueryString,
  matchQuery,
  rangeQuery,
  rangeListLengthQuery,
  sqsJoinWithAND,
  joinWithOR,
} from './es-query-builders'

const searchQuery = gql`
  query advancedSearchDatasets(
    $query: JSON!
    $cursor: String
    $datasetType: String
    $datasetStatus: String
    $sortBy: JSON
  ) {
    datasets: advancedSearch(
      query: $query
      datasetType: $datasetType
      datasetStatus: $datasetStatus
      sortBy: $sortBy
      first: 25
      after: $cursor
    ) {
      edges {
        node {
          id
          created
          uploader {
            id
            name
          }
          public
          permissions {
            id
            userPermissions {
              userId
              level
              access: level
              user {
                id
                name
                email
                provider
              }
            }
          }
          draft {
            id
            summary {
              modalities
              sessions
              subjects
              subjectMetadata {
                participantId
                age
                sex
                group
              }
              tasks
              size
              totalFiles
              dataProcessed
            }
            issues {
              severity
            }
            description {
              Name
            }
          }
          analytics {
            views
            downloads
          }
          stars {
            userId
            datasetId
          }
          followers {
            userId
            datasetId
          }
          snapshots {
            id
            created
            tag
          }
        }
      }
      pageInfo {
        startCursor
        endCursor
        hasPreviousPage
        hasNextPage
        count
      }
    }
  }
`

const isActiveRange = range =>
  JSON.stringify(range) !== JSON.stringify([null, null])
const range = ([min, max]: [Date, Date]) => {
  const minISO = min === null ? '*' : min.toISOString()
  const maxISO = max === null ? '*' : max.toISOString()
  return `[${minISO} TO ${maxISO}]`
}

// https://bids-specification.readthedocs.io/en/stable/99-appendices/04-entity-table.html
const modality_to_formats = modality => {
  switch (modality) {
    case 'MRI':
      return 'T1w OR T2w OR dwi OR bold OR asl'
    case 'EEG':
      return 'eeg'
    case 'iEEG':
      return 'ieeg'
    case 'MEG':
      return 'meg'
    case 'PET':
      return 'peg OR blood'
  }
}

export const useSearchResults = () => {
  const { searchParams } = useContext(SearchParamsCtx)
  const {
    keywords,
    datasetType_selected,
    datasetStatus_selected,
    modality_selected,
    ageRange,
    subjectCountRange,
    diagnosis_selected,
    tasks,
    authors,
    gender_selected,
    date_selected,
    species_selected,
    section_selected,
    studyDomain_selected,
    sortBy_selected,
  } = searchParams

  const boolQuery = new BoolQuery()
  if (keywords.length)
    boolQuery.addClause('must', simpleQueryString(sqsJoinWithAND(keywords)))
  if (modality_selected)
    boolQuery.addClause(
      'filter',
      matchQuery(
        'latestSnapshot.summary.modalities',
        modality_to_formats(modality_selected),
      ),
    )
  if (isActiveRange(ageRange))
    boolQuery.addClause('filter', rangeQuery('metadata.ages', ...ageRange))
  if (isActiveRange(subjectCountRange))
    boolQuery.addClause(
      'filter',
      rangeListLengthQuery(
        'latestSnapshot.summary.subjects.keyword',
        subjectCountRange[0],
        subjectCountRange[1],
      ),
    )
  if (diagnosis_selected)
    boolQuery.addClause(
      'filter',
      matchQuery('metadata.dxStatus', diagnosis_selected),
    )
  if (tasks.length)
    boolQuery.addClause(
      'must',
      simpleQueryString(sqsJoinWithAND(tasks), [
        'latestSnapshot.summary.tasks',
      ]),
    )
  if (authors.length)
    boolQuery.addClause(
      'must',
      matchQuery('metadata.seniorAuthor', joinWithOR(authors)),
    )
  if (gender_selected !== 'All')
    boolQuery.addClause(
      'filter',
      matchQuery('latestSnapshot.summary.subjectMetadata.sex', gender_selected),
    )
  if (date_selected !== 'All Time') {
    let d: number
    if (date_selected === 'Last 30 days') {
      d = 30
    } else if (date_selected === 'Last 180 days') {
      d = 180
    } else {
      d = 365
    }
    boolQuery.addClause('filter', rangeQuery('created', `now-${d}d/d`, 'now/d'))
  }
  if (species_selected)
    boolQuery.addClause(
      'filter',
      matchQuery('metadata.species', species_selected, 'AUTO'),
    )
  if (section_selected)
    boolQuery.addClause(
      'filter',
      matchQuery('metadata.studyLongitudinal', section_selected, 'AUTO'),
    )
  if (studyDomain_selected)
    boolQuery.addClause(
      'filter',
      matchQuery('metadata.studyDomain', studyDomain_selected, 'AUTO'),
    )

  let sortField = 'created',
    order = 'desc'
  switch (sortBy_selected.label) {
    case 'Activity':
      // TODO: figure this out
      break
    case 'A-Z':
      order = 'asc'
    case 'Z-A':
      sortField = 'latestSnapshot.description.Name.keyword'
      break
    case 'Oldest':
      order = 'asc'
      break
    default:
      // Newest
      break
  }
  const sortBy = { [sortField]: order }

  return useQuery(searchQuery, {
    variables: {
      query: boolQuery.get(),
      sortBy,
      datasetType: datasetType_selected,
      datasetStatus: datasetStatus_selected,
    },
    errorPolicy: 'ignore',
    // fetchPolicy is workaround for stuck loading bug (https://github.com/apollographql/react-apollo/issues/3270#issuecomment-579614837)
    // TODO: find better solution
    fetchPolicy: 'no-cache',
  })
}
