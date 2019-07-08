import falcon
import os

from datalad_service.tasks.description import update_description


class DescriptionResource(object):
    def __init__(self, store):
        self.store = store

    @property
    def annex_path(self):
        return self.store.annex_path

    def on_post(self, req, resp, dataset):
        """
        Commmit a description change.
        Returns update dataset_description
        """
        if dataset:
            try:
                description_fields = req.media.get('description_fields')
                if not any(description_fields):
                    resp.media = {
                        'error': 'Missing description field updates.'
                    }
                    resp.status = falcon.HTTP_UNPROCESSABLE_ENTITY
                dataset_description = update_description(self.store.annex_path, dataset, description_fields)
                resp.media = dataset_description
                resp.status = falcon.HTTP_OK
            except:
                resp.media = {
                    'error': 'Unexpected error in dataset_description update.'
                }
                resp.status = falcon.HTTP_500
        else:
            resp.media = {
                'error': 'Missing or malformed dataset parameter in request.'}
            resp.status = falcon.HTTP_UNPROCESSABLE_ENTITY
