FROM maven:3-eclipse-temurin-27-alpine@sha256:ce0a51cd87844a4b197f1250c520d3cf18b19639dc2fce144de885dd1cf98a23 AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B -q
COPY src ./src
RUN mvn package -DskipTests -B -q

FROM eclipse-temurin:25-jre-alpine@sha256:69c2a26e9894016e274c880fa542956d005b3755f84db765145185e87405bd89
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
EXPOSE 9000
ENTRYPOINT ["java", "-jar", "app.jar"]
