#!/usr/bin/env node

import axios from "axios";
import { glob } from "glob";
import { program } from "commander";
import { readFileSync } from "fs";
import { config } from "dotenv";
import { get, keyBy } from "lodash";

const objectTypeRegex = RegExp("[/a-zA-Z0-9]+/([a-z_]+).json");

config();

const hs = axios.create({
  baseURL: "https://api.hubapi.com/",
  params: {
    hapikey: process.env.API_KEY,
  },
});

const readJSON = (filePath: string) =>
  JSON.parse(readFileSync(filePath, "utf8"));

const getExistingSchemas = async () => {
  const { data } = await hs.get("/crm/v3/schemas");
  return keyBy(data.results, "name");
};

const createSchema = async (objectSchema: any): Promise<string | null> => {
  try {
    const { data } = await hs.post("/crm/v3/schemas", objectSchema);
    return data.objectTypeId;
  } catch (e) {
    console.log(`Failed to Create Schema ${objectSchema.name}`);
    return null;
  }
};

const createAssociation = async (association: any) => {
  try {
    const { data } = await hs.post(
      `/crm/v3/schemas/${association.fromObjectTypeId}/associations`,
      association
    );
    return data;
  } catch (e) {
    console.log(`Failed to Create Association ${association.name}`);
  }
};

const deleteSchema = async (objectTypeId: string): Promise<boolean> => {
  try {
    await hs.delete(`/crm/v3/schemas/${objectTypeId}`).catch((e) => {
      console.log(e);
      throw e;
    });
    await hs.delete(`/crm/v3/schemas/${objectTypeId}/purge`).catch((e) => {
      console.log(e);
      throw e;
    });
    return true;
  } catch (e) {
    console.log(`Failed to Delete Schema ${objectTypeId}`);
    return false;
  }
};

const pick = (obj: Record<string, any>, key: string, def?: any) => {
  const result = obj[key];
  delete obj[key];
  return result || def;
};

const createSchemas = async (fileGlob: string) => {
  const meta = await getExistingSchemas();
  const files = glob.sync(fileGlob);
  const objectTypes = files.map((x) => x.match(objectTypeRegex)!);
  const allAssociations: any[] = [];

  // Create Custom Object Schema
  for (let [filePath, objectType] of objectTypes) {
    const objectSchema = readJSON(filePath);

    // Isolate Associations
    pick(objectSchema, "associations", []).forEach((toObjectTypeId: string) => {
      allAssociations.push({
        toObjectTypeId,
        fromObjectTypeId: objectType,
        name: `${objectType}_to_${toObjectTypeId}`,
      });
    });

    const objectTypeId = await createSchema(objectSchema);
    if (objectTypeId) {
      console.log(`Created ${objectType}`);
      meta[objectType] = {
        objectTypeId,
      };
    }
  }

  // Create Associations
  for (let { name, fromObjectTypeId, toObjectTypeId } of allAssociations) {
    await createAssociation({
      name,
      fromObjectTypeId: get(
        meta,
        `${fromObjectTypeId}.objectTypeId`,
        fromObjectTypeId
      ),
      toObjectTypeId: get(
        meta,
        `${toObjectTypeId}.objectTypeId`,
        toObjectTypeId
      ),
    });
  }
};

const deleteSchemas = async (fileGlob: string) => {
  const meta = await getExistingSchemas();
  const files = glob.sync(fileGlob);
  const objectTypes = files.map((x) => x.match(objectTypeRegex)!);
  for (let [_, objectType] of objectTypes) {
    const objectTypeId = meta[objectType].objectTypeId;
    const success = await deleteSchema(objectTypeId);
    if (success) {
      console.log(`Deleted ${objectType}`);
    }
  }
};

const shouldContainAll = (a: any[], b: any[]) => {
  return a.every((aOption) => {
    return b.find((bOption) => {
      return bOption.label === aOption.label && bOption.value === aOption.value;
    });
  });
};

const validateOptions = (existingOptions: any[], currentOptions: any[]) => {
  return (
    shouldContainAll(existingOptions, currentOptions) &&
    shouldContainAll(currentOptions, existingOptions)
  );
};

const updateSchema = async (updatedSchema: any, currentSchema: any) => {
  const updatedProperties = pick(updatedSchema, "properties");
  const currentProperties = pick(currentSchema, "properties");

  const toDelete = currentProperties.filter(({ name }: any) => {
    return (
      !(name.includes("hs_") || name.includes("hubspot_")) &&
      !updatedProperties.find((prop: any) => prop.name === name)
    );
  });

  const toCreate = updatedProperties.filter(({ name }: any) => {
    return !currentProperties.find((prop: any) => prop.name === name);
  });

  const toUpdate = updatedProperties.filter((updatedProperty: any) => {
    const existingProperty = currentProperties.find(
      (prop: any) => prop.name === updatedProperty.name
    );
    if (!existingProperty) return false;
    return Object.keys(updatedProperty).reduce((acc, curr) => {
      if (acc) return acc;
      if (Array.isArray(updatedProperty[curr])) {
        return !validateOptions(updatedProperty[curr], existingProperty[curr]);
      } else {
        return updatedProperty[curr] !== existingProperty[curr];
      }
    }, false);
  });

  for (let toDeleteProperty of toDelete) {
    console.log(
      `Deleting property ${toDeleteProperty.name} on ${currentSchema.name}`
    );
    await hs.delete(
      `/properties/v2/${currentSchema.objectTypeId}/properties/named/${toDeleteProperty.name}`
    );
  }

  for (let toCreateProperty of toCreate) {
    console.log(
      `Creating property ${toCreateProperty.name} on ${currentSchema.name}`
    );
    await hs.post(
      `/properties/v2/${currentSchema.objectTypeId}/properties`,
      toCreateProperty
    );
  }

  for (let toUpdateProperty of toUpdate) {
    console.log(
      `Updating property ${toUpdateProperty.name} on ${currentSchema.name}`
    );
    await hs
      .patch(
        `/properties/v2/${currentSchema.objectTypeId}/properties/named/${toUpdateProperty.name}`,
        toUpdateProperty
      )
      .catch((e) => console.log(e));
  }
};

const updateSchemas = async (fileGlob: string) => {
  const meta = await getExistingSchemas();
  const files = glob.sync(fileGlob);
  const objectTypes = files.map((x) => x.match(objectTypeRegex)!);

  for (let [filePath, objectType] of objectTypes) {
    const objectSchema = readJSON(filePath);
    if (!meta[objectType]) {
      console.log(`Object Type ${objectType} does not exist to be updated.`);
      continue;
    }
    await updateSchema(objectSchema, meta[objectType]);
  }
};

program.command("create <glob>").action(createSchemas);
program.command("delete <glob>").action(deleteSchemas);
program.command("update <glob>").action(updateSchemas);

program.parse();
