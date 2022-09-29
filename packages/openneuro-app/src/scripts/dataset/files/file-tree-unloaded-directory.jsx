import React, { useState, useContext, useEffect } from 'react'
import PropTypes from 'prop-types'
import DatasetQueryContext from '../../datalad/dataset/dataset-query-context.js'
import FileTreeLoading from './file-tree-loading.jsx'
import { gql } from '@apollo/client'
import { AccordionTab } from '@openneuro/components/accordion'

export const DRAFT_FILES_QUERY = gql`
  query dataset($datasetId: ID!, $tree: String!) {
    dataset(id: $datasetId) {
      draft {
        files(tree: $tree) {
          id
          key
          filename
          size
          directory
          annexed
        }
      }
    }
  }
`

export const SNAPSHOT_FILES_QUERY = gql`
  query snapshot($datasetId: ID!, $snapshotTag: String!, $tree: String!) {
    snapshot(datasetId: $datasetId, tag: $snapshotTag) {
      files(tree: $tree) {
        id
        key
        filename
        size
        directory
        annexed
      }
    }
  }
`

/**
 * Prepend paths to the tree object returned to get absolute filenames
 */
export const nestFiles = path => file => ({
  ...file,
  filename: `${path}:${file.filename}`,
})

/**
 * Merge cached dataset files with newly received data
 */
export const mergeNewFiles =
  (directory, snapshotTag) =>
  (past, { fetchMoreResult }) => {
    // Deep clone the old dataset object
    const path = directory.filename
    const newDatasetObj = JSON.parse(JSON.stringify(past))
    const newFiles = snapshotTag
      ? newDatasetObj.snapshot.files
      : newDatasetObj.dataset.draft.files
    const fetchMoreData = snapshotTag
      ? fetchMoreResult.snapshot
      : fetchMoreResult.dataset.draft
    newFiles.push(...fetchMoreData.files.map(nestFiles(path)))
    return newDatasetObj
  }

export const fetchMoreDirectory = (
  fetchMore,
  datasetId,
  snapshotTag,
  directory,
) =>
  fetchMore({
    query: snapshotTag ? SNAPSHOT_FILES_QUERY : DRAFT_FILES_QUERY,
    variables: { datasetId, snapshotTag, tree: directory.id },
    updateQuery: mergeNewFiles(directory, snapshotTag),
  })

const FileTreeUnloadedDirectory = ({ datasetId, snapshotTag, directory }) => {
  const [loading, setLoading] = useState(false)
  const [displayLoading, setDisplayLoading] = useState(false)
  const { fetchMore } = useContext(DatasetQueryContext)
  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => setDisplayLoading(true), 150)
      return () => clearTimeout(timer)
    }
  }, [loading])
  return (
    <AccordionTab
      label={directory.filename.split(':').pop()}
      accordionStyle="file-tree"
      onClick={() => {
        // Show a loading state while we wait on the directory to stream in
        setLoading(true)
        fetchMoreDirectory(fetchMore, datasetId, snapshotTag, directory)
        // No need to clear since this component is unmounted immediately
      }}>
      <FileTreeLoading size={directory.size} />
    </AccordionTab>
  )
}

FileTreeUnloadedDirectory.propTypes = {
  datasetId: PropTypes.string,
  snapshotTag: PropTypes.string,
  directory: PropTypes.object,
}

export default FileTreeUnloadedDirectory
