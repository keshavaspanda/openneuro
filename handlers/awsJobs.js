/*eslint no-console: ["error", { allow: ["log"] }] */
// dependencies ------------------------------------------------------------

import aws     from '../libs/aws';
import scitran from '../libs/scitran';
import crypto  from 'crypto';
import uuid    from 'uuid';
import mongo         from '../libs/mongo';
import {ObjectID}    from 'mongodb';
import archiver      from 'archiver';
import config from '../config';
import async from 'async';
import notifications from '../libs/notifications';
import emitter from '../libs/events';

let c = mongo.collections;
let events = config.events;

//Job Polling

// handlers ----------------------------------------------------------------

/**
 * Jobs
 *
 * Handlers for job actions.
 */
let handlers = {

    /**
     * Create Job Definition
     */
    createJobDefinition(req, res, next) {
        let jobDef = Object.assign({},req.body);

        aws.batch.registerJobDefinition(jobDef, (err, data) => {
            if (err) {
                console.log(err);
                return next(err);
            } else {
                let extendeJobDef = data;
                extendeJobDef.parameters = req.body.parameters || {};
                extendeJobDef.descriptions = req.body.descriptions || {};
                extendeJobDef.parametersMetadata = req.body.parametersMetadata || {};
                extendeJobDef.analysisLevels = req.body.analysisLevels || [];
                c.crn.jobDefinitions.insertOne(extendeJobDef, (err) => {
                    if(err){
                        //TODO -- error handling? make response dependant on inserting document?
                    }
                });
                // can go ahead and respond to client without waiting on mongo insert
                res.send(data);
            }
        });
    },

    /**
    * Delete App Definition
    */
    deleteJobDefinition(req, res, next) {
        let appId = req.params.appId;
        aws.batch.deleteJobDefinition(appId, (err, data) => {
            if (err) {
                return next(err);
            } else {
                res.send(data);
            }
        });
    },

    /**
     * Describe Job Definitions
     */
    describeJobDefinitions(req, res, next) {
        //recursive function to handle grabbing all job definitions if more than 100 exist on batch
        let getJobDefinitions = (params, jobDefs, callback) => {
            aws.batch.sdk.describeJobDefinitions(params, (err, data) => {
                if(err) {return callback(err);}
                jobDefs = jobDefs.concat(data.jobDefinitions);
                if(data.nextToken) {
                    params.nextToken = data.nextToken;
                    getJobDefinitions(params, jobDefs, callback);
                } else {
                    callback(null, jobDefs);
                }
            });
        };

        c.crn.jobDefinitions.find({}, {jobDefinitionArn: true}).toArray((err, appDefs) => {
            let arns = appDefs.map((app) => {
                return app.jobDefinitionArn;
            });
            getJobDefinitions({jobDefinitions: arns}, [], (err, jobDefs) => {
                if (err) {
                    console.log(err);
                    return next(err);
                } else {
                    let definitions = {};
                    //need to attach job definition descriptions from mongo to job defs returned from AWS batch
                    async.each(jobDefs, (definition, cb) => {
                        if (!definitions.hasOwnProperty(definition.jobDefinitionName)) {
                            definitions[definition.jobDefinitionName] = {};
                        }
                        c.crn.jobDefinitions.find({
                            jobDefinitionName: definition.jobDefinitionName,
                            jobDefinitionArn: definition.jobDefinitionArn,
                            revision: definition.revision
                        }, {descriptions: true, parameters: true, parametersMetadata: true, analysisLevels: true}).toArray((err, def) => {
                            // there will either be a one element array or an empty array returned
                            let parameters = def.length === 0 || !def[0].parameters ? {} : def[0].parameters;
                            let descriptions = def.length === 0 || !def[0].descriptions ? {} : def[0].descriptions;
                            let parametersMetadata = def.length === 0 || !def[0].parametersMetadata ? {} : def[0].parametersMetadata;
                            let analysisLevels = def.length === 0 || !def[0].analysisLevels ? {} : def[0].analysisLevels;
                            definition.parameters = parameters;
                            definition.descriptions = descriptions;
                            definition.parametersMetadata = parametersMetadata;
                            definition.analysisLevels = analysisLevels;
                            definitions[definition.jobDefinitionName][definition.revision] = definition;
                            cb();
                        });
                    }, () => {
                        res.send(definitions);
                    });
                }
            });
        });
    },

    /**
     * Submit Job
     * Inserts a job document into mongo and starts snapshot upload
     * returns job to client
     */
    submitJob(req, res, next) {
        let userId = req.user;
        let job = req.body;

        job.uploadSnapshotComplete = !!job.uploadSnapshotComplete;
        job.analysis = {
            analysisId: uuid.v4(),
            status: 'UPLOADING',
            created: new Date(),
            attempts: 0,
            notification: false
        };
        //making consistent with agave ??
        job.appLabel = job.jobName;
        job.appVersion = job.jobDefinition.match(/\d+$/)[0];

        scitran.downloadSymlinkDataset(job.snapshotId, (err, hash) => {
            job.datasetHash = hash;
            job.parametersHash = crypto.createHash('md5').update(JSON.stringify(job.parameters)).digest('hex');

            // jobDefintion is the full ARN including version, region, etc
            c.crn.jobs.findOne({
                jobDefinition:  job.jobDefinition,
                datasetHash:    job.datasetHash,
                parametersHash: job.parametersHash,
                snapshotId:     job.snapshotId
            }, {}, (err, existingJob) => {
                if (err){return next(err);}
                if (existingJob) {
                    // allow retrying failed jobs
                    if (existingJob.analysis && existingJob.analysis.status === 'FAILED') {
                        handlers.retry({params: {jobId: existingJob.jobId}}, res, next);
                        return;
                    }
                    res.status(409).send({message: 'A job with the same dataset and parameters has already been run.'});
                    return;
                }

                c.crn.jobs.insertOne(job, (err, mongoJob) => {

                    // Finish the client request so S3 upload can happen async
                    res.send({jobId: mongoJob.insertedId});

                    // TODO - handle situation where upload to S3 fails
                    aws.s3.uploadSnapshot(hash, () => {
                        const batchJobParams = aws.batch.buildBatchParams(job, hash);

                        aws.batch.startBatchJob(batchJobParams, mongoJob.insertedId, (err) => {
                            if (err) {
                                // This is an unexpected error, probably from batch.
                                console.log(err);
                                // Cleanup the failed to submit job
                                // TODO - Maybe we save the error message into another field for display?
                                c.crn.jobs.updateOne({_id: mongoJob.insertedId}, {$set: {'analysis.status': 'REJECTED'}});
                                return;
                            } else {
                                emitter.emit(events.JOB_STARTED, {job: batchJobParams, createdDate: job.analysis.created}, userId);
                            }
                        });
                    });
                });
            });
        }, {snapshot: true});
    },

    /**
     * GET Job
     */
    getJob(req, res, next) {
        let userId = req.user;
        let jobId = req.params.jobId; //this is the mongo id for the job.

        c.crn.jobs.findOne({_id: ObjectID(jobId)}, {}, (err, job) => {
            if (!job) {
                res.status(404).send({message: 'Job not found.'});
                return;
            }
            let status = job.analysis.status;
            let jobs = job.analysis.jobs;

            // check if job is already known to be completed
            // there could be a scenario where we are polling before the AWS batch job has been setup. !jobs check handles this.
            if ((status === 'SUCCEEDED' && job.results && job.results.length > 0) || status === 'FAILED' || status === 'REJECTED' || !jobs || !jobs.length) {
                res.send(job);
            } else {
                handlers.getJobStatus(job, userId, (err, data) => {
                    if(err) {return next(err);}
                    res.send(data);
                });
            }
        });
    },

    /**
     * GET File
     * listObjects to find everything in the s3 bucket for a given job
     * stream all files in series(?) to zip
     */
    downloadAllS3(req, res) {
        let jobId = req.params.jobId;

        const path = 'all-results'; //req.ticket.filePath;
        if (path === 'all-results' || path === 'all-logs') {

            const type = path.replace('all-', '');

            // initialize archive
            let archive = archiver('zip');

            // log archiving errors
            archive.on('error', (err) => {
                console.log('archiving error - job: ' + jobId);
                console.log(err);
            });

            c.crn.jobs.findOne({_id: ObjectID(jobId)}, {}, (err, job) => {
                let archiveName = job.datasetLabel + '__' + job.analysis.analysisId + '__' + type;
                let s3Prefix = job.datasetHash + '/' + job.analysis.analysisId + '/';
                //params to list objects for a job
                let params = {
                    Bucket: config.aws.s3.analysisBucket,
                    Prefix: s3Prefix,
                    StartAfter: s3Prefix
                };

                // set archive name
                res.attachment(archiveName + '.zip');

                // begin streaming archive
                archive.pipe(res);

                aws.s3.sdk.listObjectsV2(params, (err, data) => {
                    let keysArray = [];
                    data.Contents.forEach((obj) => {
                        //only include files in results. listObjectsV2 returns keys for directories also so need to filter those out.
                        if(!/\/$/.test(obj.Key)) {
                            keysArray.push(obj.Key);
                        }
                    });

                    async.eachSeries(keysArray, (key, cb) => {
                        let objParams = {
                            Bucket: config.aws.s3.analysisBucket,
                            Key: key
                        };
                        let fileName = key.split('/').slice(2).join('/');
                        aws.s3.sdk.getObject(objParams, (err, response) => {
                            //append to zip
                            archive.append(response.Body, {name: fileName});
                            cb();
                        });
                    }, () => {
                        archive.finalize();
                    });
                });
            });
        }

    },

    getJobLogs (req, res, next) {
        let jobId = req.params.jobId; //this will be the mongoId for a given analysis

        aws.cloudwatch.getLogsByJobId(jobId, (err, logs) => {
            if (err) {
                return next(err);
            } else {
                res.send(logs);
            }
        });
    },

    downloadJobLogs (req, res, next) {
        let jobId = req.params.jobId; //this will be the mongoId for a given analysis

        aws.cloudwatch.getLogsByJobId(jobId, (err, logs) => {
            if (err) {
                return next(err);
            } else {
                res.attachment(jobId + '.json');
                res.send(logs);
            }
        });
    },

    getLogstream(req, res, next) {
        let appName = req.params.app;
        let jobId = req.params.jobId;
        let taskArn = req.params.taskArn;
        let key = appName + '/' + jobId + '/' + taskArn;

        aws.cloudwatch.getLogs(key, [], null, true, (err, logs) => {
            if (err) {
                return next(err);
            } else {
                res.send(logs);
            }
        });
    },

    /**
     * Retry a job using existing parameters
     */
    retry (req, res, next) {
        let jobId = req.params.jobId;
        let mongoJobId = typeof jobId != 'object' ? ObjectID(jobId) : jobId;

        // find job
        c.crn.jobs.findOne({_id: mongoJobId}, {}, (err, job) => {
            if (err){return next(err);}
            if (!job) {
                let error = new Error('Could not find job.');
                error.http_code = 404;
                return next(error);
            }
            if (job.analysis.status && job.analysis.status === 'SUCCEEDED') {
                let error = new Error('A job with the same dataset and parameters has already successfully finished.');
                error.http_code = 409;
                return next(error);
            }
            if (job.analysis.status && job.analysis.status !== 'FAILED' && job.analysis.status !== 'REJECTED') {
                let error = new Error('A job with the same dataset and parameters is currently running.');
                error.http_code = 409;
                return next(error);
            }

            c.crn.jobs.updateOne({_id: mongoJobId}, {
                $set: {
                    'analysis.status': 'RETRYING',
                    'analysis.jobs': []
                }
            });

            res.send({jobId: mongoJobId});

            const batchJobParams = aws.batch.buildBatchParams(job);

            aws.batch.startBatchJob(batchJobParams, mongoJobId, (err) => {
                if (err) {
                    // This is an unexpected error, probably from batch.
                    console.log(err);
                    // Cleanup the failed to submit job
                    // TODO - Maybe we save the error message into another field for display?
                    c.crn.jobs.updateOne({_id: mongoJobId}, {$set: {'analysis.status': 'REJECTED'}});
                    return;
                } else {
                    emitter.emit(events.JOB_STARTED, {job: batchJobParams, createdDate: job.analysis.created, retry: true});
                }
            });
        });
    },

    /*
     * Gets jobs for a given analysis from batch, checks overall status and callsback with a snapshot of the analysis status
     */
    getJobStatus(job, userId, callback) {
        aws.batch.getAnalysisJobs(job, (err, jobs) => {
            if(err) {return callback(err);}
            //check jobs status
            let analysis = {};
            let createdDate = job.analysis.created;
            let analysisId = job.analysis.analysisId;
            let statusArray = jobs.map((job) => {
                return job.status;
            });
            let finished = handlers._checkJobStatus(statusArray);

            analysis.status = !finished ? 'RUNNING' : 'FINALIZING';
            analysis.created = createdDate;
            analysis.analysisId = analysisId;

            let logStreams = handlers._buildLogStreams(jobs);

            if(finished) {
                analysis.status = !statusArray.length || statusArray.some((status)=>{ return status === 'FAILED';}) ? 'FAILED' : 'SUCCEEDED';
                // emit a job finished event so we can add logs and sent notification email
                // cloning job here and sending out event and email because mongos updateOne does not return updated doc
                let clonedJob = JSON.parse(JSON.stringify(job));
                clonedJob.analysis.status = analysis.status;
                aws.batch.jobComplete(clonedJob, userId);
            }

            let s3Prefix = job.datasetHash + '/' + job.analysis.analysisId + '/';
            let params = {
                Bucket: 'openneuro.outputs',
                Prefix: s3Prefix,
                StartAfter: s3Prefix
            };

            aws.s3.getJobResults(params, (err, results) => {
                if(err) {return callback(err);}
                //update job with status, results and logstreams
                let jobId = typeof job._id === 'object' ? job._id : ObjectID(job._id);
                let jobUpdate = {
                    'analysis.status': analysis.status,
                    results: results
                };
                c.crn.jobs.updateOne({_id: jobId}, {
                    $set: jobUpdate,
                    $addToSet: {'analysis.logstreams': {$each: logStreams}}
                });
            });

            if (callback) {
                callback(null, {
                    analysis: analysis,
                    jobId: analysisId,
                    datasetId: job.datasetId,
                    snapshotId: job.snapshotId
                });
            }
        });
    },

    /*
     * Takes an array of statuses for batch jobs and returns a boolean denoting overall finished state of all jobs
     */
    _checkJobStatus(statusArray) {
        //if every status is either succeeded or failed, all jobs have completed.
        let finished = statusArray.length ? statusArray.every((status) => {
            return status === 'SUCCEEDED' || status === 'FAILED';
        }) : false;

        return finished;
    },

    /*
     * Takes an array of job objects and constructs path to the cloudwatch logstreams
     */
    _buildLogStreams(jobs) {
        let logStreamNames;
        if(jobs && jobs.length > 0) {
            logStreamNames = jobs.reduce((acc, job) => {
                if (job.attempts && job.attempts.length > 0) {
                    job.attempts.forEach((attempt)=> {
                        let streamObj = {
                            name: job.jobName + '/' + job.jobId + '/' + attempt.container.taskArn.split('/').pop(),
                            environment: job.container.environment,
                            exitCode: job.container.exitCode
                        };
                        acc.push(streamObj);
                    });
                }
                return acc;
            }, []);
        }

        return logStreamNames;
    }

};

export default handlers;
