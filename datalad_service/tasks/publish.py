from datalad.api import create_sibling_github

from datalad_service.config import DATALAD_GITHUB_ORG
from datalad_service.config import DATALAD_GITHUB_LOGIN
from datalad_service.config import DATALAD_GITHUB_PASS
from datalad_service.common.s3 import DatasetRealm, setup_s3_sibling, s3_export
from datalad_service.common.celery import dataset_task


def create_github_repo(dataset, repo_name):
    """Setup a github sibling / remote."""
    try:
        # this adds github remote to config and also creates repo
        return create_sibling_github(repo_name,
                                     github_login=DATALAD_GITHUB_LOGIN,
                                     github_passwd=DATALAD_GITHUB_PASS,
                                     github_organization=DATALAD_GITHUB_ORG,
                                     dataset=dataset,
                                     access_protocol='ssh')
    except KeyError:
        raise Exception(
            'DATALAD_GITHUB_LOGIN, DATALAD_GITHUB_PASS, DATALAD_GITHUB_ORG must be defined to create remote repos')


def get_sibling_by_name(name, siblings):
    return any(
        filter(lambda sibling: sibling['name'] == name, siblings)
    )


def github_sibling(ds, repo_name, siblings):
    """
    Find a GitHub remote or create a new repo and configure the remote.
    """
    sibling = get_sibling_by_name('github', siblings)
    if not sibling:
        create_github_repo(ds, repo_name)
    return sibling


def s3_sibling(dataset, siblings, realm=DatasetRealm.PRIVATE):
    """
    Setup a special remote for a versioned S3 remote.

    The bucket must already exist and be configured.
    """
    sibling = get_sibling_by_name(realm.s3_remote, siblings)
    if not sibling:
        setup_s3_sibling(dataset, realm)
    return sibling


def publish_target(dataset, target, treeish):
    """
    Publish target of dataset.

    This exists so the actual publish can be easily mocked.
    """
    if target == 'github':
        return dataset.publish(to=target)
    else:
        return s3_export(dataset, target, treeish)


@dataset_task
def publish_snapshot(store, dataset, snapshot, realm='PRIVATE'):
    """Publish a snapshot tag to S3, GitHub or both."""
    realm = DatasetRealm[realm]
    dataset_id = dataset
    ds = store.get_dataset(dataset)
    siblings = ds.siblings()
    s3_remote = s3_sibling(ds, siblings)
    publish_target(ds, realm.s3_remote, snapshot)
    # Public publishes to GitHub
    if realm == DatasetRealm.PUBLIC:
        github_remote = github_sibling(ds, dataset_id, siblings)
        publish_target(ds, realm.github_remote, snapshot)
